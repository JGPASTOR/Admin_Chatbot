import os
import re
import json
import pickle
import logging
import threading
import requests
from typing import List, Optional
import numpy as np

logger = logging.getLogger(__name__)

# Lock to prevent race conditions when concurrent requests read/write _chunks and _embeddings
_rag_lock = threading.Lock()

# Lazy-loaded globals — initialized on first use
_rag_ready: bool = False
_chunks: List[str] = []
_chunk_filenames: List[str] = []
_embeddings = None
_embedding_model = None
_store_dir: str = ""   # set during initialize_rag; used by add_document_to_index


_MAX_CHUNK_CHARS = 3000  # hard cap per chunk

# Matches lines that are 3+ repeated decorative characters (═══, ----, ====, etc.)
_DECO_LINE_RE = re.compile(r'^([═=\-_*~─━▬])\1{2,}$')


def _clean_text(text: str) -> str:
    """Strip decorative separator lines and junk characters from document text."""
    cleaned = []
    for line in text.splitlines():
        t = line.strip()
        if _DECO_LINE_RE.match(t):
            continue
        # Drop lines that are mostly non-alphanumeric (table borders, box-drawing art)
        if len(t) > 0 and len(re.sub(r'[^a-zA-Z0-9]', '', t)) / len(t) < 0.2:
            continue
        cleaned.append(line)
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(cleaned)).strip()


def _chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> List[str]:
    """
    Chunk text so that every chunk contains only ONE topic — no bleed-over.

    Rules (in order):
    1. Split on SECTION headers → each section is its own unit.
    2. Keep the whole section as one chunk (so "section 1" always returns
       ALL of section 1, never a cut-off half).
    3. If a section exceeds _MAX_CHUNK_CHARS, split only at blank lines
       (paragraph boundaries) — never mid-sentence.
    4. For content before the first SECTION header (intro text, names, etc.),
       split by paragraph so short facts (e.g. "The mayor is John Doe") stay
       in their own retrievable chunk.
    """
    text = _clean_text(text)
    section_pattern = re.compile(r'(?=\bSECTION\s+\d+\b)', re.IGNORECASE)
    parts = section_pattern.split(text)

    chunks = []

    for part in parts:
        part = part.strip()
        if not part:
            continue

        if len(part) <= _MAX_CHUNK_CHARS:
            chunks.append(part)
            continue

        # Too long — split at paragraph boundaries only
        paragraphs = [p.strip() for p in re.split(r'\n\s*\n', part) if p.strip()]
        current = ""
        for para in paragraphs:
            candidate = (current + "\n\n" + para).strip() if current else para
            if len(candidate) <= _MAX_CHUNK_CHARS:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                # A single paragraph longer than the cap: keep it whole anyway
                # (a big chunk is better than a broken sentence)
                current = para
        if current:
            chunks.append(current)

    return chunks


def _fetch_all_from_api(list_api_url: str) -> list:
    """
    Fetch extracted text from ALL general documents via the Admin API list endpoint.
    Returns a list of (original_name, text) tuples.
    """
    try:
        logger.info(f"[RAG] Fetching document list from: {list_api_url}")
        res = requests.get(list_api_url, timeout=15)
        res.raise_for_status()
        data = res.json()

        if not data.get("success") or not isinstance(data.get("data"), list):
            logger.warning("[RAG] List API returned no documents.")
            return []

        docs = []
        for item in data["data"]:
            doc_id = item.get("id")
            original_name = item.get("original_name", f"document_{doc_id}")
            # Fetch full doc with extracted_data
            detail_url = f"{list_api_url}/{doc_id}"
            try:
                detail_res = requests.get(detail_url, timeout=15)
                detail_res.raise_for_status()
                detail = detail_res.json()
                if detail.get("success") and isinstance(detail.get("data"), dict):
                    extracted = detail["data"].get("extracted_data", {})
                    if isinstance(extracted, str):
                        try:
                            extracted = json.loads(extracted)
                        except Exception:
                            extracted = {}
                    text = extracted.get("text", "").strip() if isinstance(extracted, dict) else ""
                    if text:
                        docs.append((original_name, text))
                        logger.info(f"[RAG] Loaded document: {original_name} ({len(text)} chars)")
            except Exception as e:
                logger.warning(f"[RAG] Failed to fetch document {doc_id}: {e}")
        return docs
    except Exception as e:
        logger.error(f"[RAG] Failed to fetch document list: {e}")
        raise


def _build_or_load_index(api_url: str, store_dir: str) -> None:
    """
    Build the vector embeddings from the API if not already built,
    otherwise load the existing numpy arrays from the cache file.
    """
    global _chunks, _chunk_filenames, _embeddings, _embedding_model
    from sentence_transformers import SentenceTransformer

    os.makedirs(store_dir, exist_ok=True)
    cache_path = os.path.join(store_dir, "rag_cache.pkl")

    # Load embedding model once
    _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

    # If cache exists, load it
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                data = pickle.load(f)
                _chunks = data["chunks"]
                _embeddings = data["embeddings"]
                # Backwards compatible: if old cache without filenames, fill with 'unknown'
                _chunk_filenames = data.get("filenames", ["unknown"] * len(_chunks))
            logger.info(f"[RAG] Loaded existing index from disk cache. ({len(_chunks)} chunks)")
            return
        except Exception as e:
            logger.warning(f"[RAG] Failed to load cache: {e}. Re-indexing...")

    # Otherwise, fetch documents from Admin API and build index
    logger.info(f"[RAG] Indexing all documents from {api_url} ...")
    doc_list = _fetch_all_from_api(api_url)

    if not doc_list:
        raise ValueError(f"No documents returned from {api_url}. Upload a document first.")

    all_chunks = []
    all_filenames = []
    for original_name, text in doc_list:
        doc_chunks = _chunk_text(text, chunk_size=500, overlap=100)
        all_chunks.extend(doc_chunks)
        all_filenames.extend([original_name] * len(doc_chunks))

    _chunks = all_chunks
    _chunk_filenames = all_filenames

    # Encode all chunks to vectors
    _embeddings = _embedding_model.encode(_chunks, convert_to_numpy=True)

    # Save to cache
    with open(cache_path, "wb") as f:
        pickle.dump({
            "chunks": _chunks,
            "embeddings": _embeddings,
            "filenames": _chunk_filenames
        }, f)

    logger.info(f"[RAG] Ready. {len(_chunks)} chunks indexed from {len(doc_list)} documents.")


def rebuild_index() -> int:
    """
    Force a full rebuild of the RAG index by fetching all documents from the Admin API.
    Returns the number of indexed chunks.
    """
    global _chunks, _chunk_filenames, _embeddings, _embedding_model, _rag_ready

    if not _store_dir:
        raise RuntimeError("[RAG] Store directory not set. Was initialize_rag called?")
        
    api_url = os.environ.get("RAG_DOCUMENT_API_URL", "http://localhost:3005/api/general-documents")
    
    logger.info(f"[RAG] Rebuilding index from {api_url} ...")
    doc_list = _fetch_all_from_api(api_url)

    if not doc_list:
        with _rag_lock:
            _chunks = []
            _chunk_filenames = []
            _embeddings = np.array([])
        # clear cache file if existing
        cache_path = os.path.join(_store_dir, "rag_cache.pkl")
        if os.path.exists(cache_path):
            os.remove(cache_path)
        logger.info("[RAG] Rebuild complete: No documents found. Cleared index.")
        return 0

    all_chunks = []
    all_filenames = []
    for original_name, text in doc_list:
        doc_chunks = _chunk_text(text, chunk_size=500, overlap=100)
        all_chunks.extend(doc_chunks)
        all_filenames.extend([original_name] * len(doc_chunks))

    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

    new_embeddings = _embedding_model.encode(all_chunks, convert_to_numpy=True)

    with _rag_lock:
        _chunks = list(all_chunks)
        _chunk_filenames = list(all_filenames)
        _embeddings = new_embeddings
        _rag_ready = True

    # Persist to disk
    os.makedirs(_store_dir, exist_ok=True)
    cache_path = os.path.join(_store_dir, "rag_cache.pkl")
    with open(cache_path, "wb") as f:
        pickle.dump({
            "chunks": _chunks,
            "embeddings": _embeddings,
            "filenames": _chunk_filenames
        }, f)

    logger.info(f"[RAG] Rebuild complete. {len(all_chunks)} chunks indexed from {len(doc_list)} documents.")
    return len(all_chunks)


def initialize_rag(api_url: str, store_dir: str) -> None:
    """
    Initialize the RAG index at application startup.
    Call this once from main.py lifespan so the index is ready before requests come in.
    """
    global _rag_ready, _store_dir

    _store_dir = store_dir  # remember for later ingest calls

    if not api_url:
        logger.warning("[RAG] No API URL provided. RAG disabled.")
        return

    try:
        _build_or_load_index(api_url, store_dir)
        _rag_ready = True
        logger.info("[RAG] Initialization complete.")
    except Exception as e:
        logger.error(f"[RAG] Failed to initialize: {e}")
        _rag_ready = False


def add_document_to_index(text: str, filename: str = "unknown") -> int:
    """
    Ingest raw text from an uploaded document into the live RAG index.

    - Chunks the text using the same parameters as the initial build.
    - Generates embeddings and appends them to the in-memory arrays.
    - Persists the updated index to rag_cache.pkl so it survives restarts.

    Returns:
        Number of new chunks that were added.

    Raises:
        RuntimeError: If the embedding model is not yet loaded.
    """
    global _chunks, _chunk_filenames, _embeddings, _embedding_model, _rag_ready

    if not _store_dir:
        raise RuntimeError("[RAG] RAG store directory not configured. Call initialize_rag() first.")

    if _embedding_model is None:
        raise RuntimeError("[RAG] Embedding model is not loaded. Call initialize_rag() first.")

    new_chunks = _chunk_text(text, chunk_size=500, overlap=100)
    if not new_chunks:
        logger.warning(f"[RAG] No chunks extracted from '{filename}'. Skipping.")
        return 0

    new_embeddings = _embedding_model.encode(new_chunks, convert_to_numpy=True)

    with _rag_lock:
        _chunks.extend(new_chunks)
        _chunk_filenames.extend([filename] * len(new_chunks))
        if _embeddings is None:
            _embeddings = new_embeddings
        else:
            _embeddings = np.vstack([_embeddings, new_embeddings])
        _rag_ready = True
        chunks_to_persist = list(_chunks)
        filenames_to_persist = list(_chunk_filenames)
        embeddings_to_persist = _embeddings

    # Persist the updated index (outside lock to avoid holding during I/O)
    cache_path = os.path.join(_store_dir, "rag_cache.pkl")
    os.makedirs(_store_dir, exist_ok=True)
    with open(cache_path, "wb") as f:
        pickle.dump({"chunks": chunks_to_persist, "embeddings": embeddings_to_persist, "filenames": filenames_to_persist}, f)

    logger.info(f"[RAG] Added {len(new_chunks)} chunks from '{filename}' to index and saved cache.")
    return len(new_chunks)


def delete_document_from_index(filename: str) -> int:
    """
    Remove all chunks and embeddings associated with a specific document filename.
    
    Returns:
        Number of chunks deleted.
    """
    global _chunks, _chunk_filenames, _embeddings, _rag_ready

    if not _rag_ready or not _chunks:
        return 0

    with _rag_lock:
        # Find indices of chunks that belong to this filename
        indices_to_delete = [i for i, fn in enumerate(_chunk_filenames) if fn == filename]
        
        if not indices_to_delete:
            return 0
            
        # Delete from lists (reverse order to maintain correct indices during deletion)
        for i in sorted(indices_to_delete, reverse=True):
            del _chunks[i]
            del _chunk_filenames[i]
            
        # Delete from numpy array
        if _embeddings is not None:
            _embeddings = np.delete(_embeddings, indices_to_delete, axis=0)
            
        chunks_to_persist = list(_chunks)
        filenames_to_persist = list(_chunk_filenames)
        embeddings_to_persist = _embeddings

    # Persist the updated index
    if _store_dir:
        cache_path = os.path.join(_store_dir, "rag_cache.pkl")
        if os.path.exists(cache_path):
            with open(cache_path, "wb") as f:
                pickle.dump({"chunks": chunks_to_persist, "embeddings": embeddings_to_persist, "filenames": filenames_to_persist}, f)

    logger.info(f"[RAG] Deleted {len(indices_to_delete)} chunks for '{filename}' and updated cache.")
    return len(indices_to_delete)


def retrieve_context(query: str, top_k: int = 3) -> Optional[str]:
    """
    Retrieve the most relevant document chunks for a user query.

    Args:
        query: The user's question or message.
        top_k: How many chunks to return.

    Returns:
        A single string with the top-K chunks joined, or None if RAG is not ready.
    """
    global _chunks, _embeddings, _embedding_model

    if not _rag_ready or _embeddings is None or _embedding_model is None:
        return None

    # Guard: if all documents have been deleted, the index is empty — skip retrieval
    if len(_chunks) == 0 or _embeddings.shape[0] == 0:
        return None

    try:
        from sklearn.metrics.pairwise import cosine_similarity

        with _rag_lock:
            chunks_snapshot = list(_chunks)
            # Copy the array to avoid mutation from concurrent delete operations
            embeddings_snapshot = _embeddings.copy()

        # 1. Embed the query
        query_emb = _embedding_model.encode([query], convert_to_numpy=True)

        # 2. Compute semantic similarity against all chunks
        similarities = cosine_similarity(query_emb, embeddings_snapshot)[0]

        query_lower = query.lower()

        # 3. Section-targeted boosting
        # When the query specifically references "section N", strongly prioritize that
        # section and penalize chunks that belong to other sections.
        section_query_match = re.search(r'\bsection\s+(\d+)\b', query_lower)
        if section_query_match:
            target_section = section_query_match.group(1)
            target_pattern = re.compile(
                rf'\bsection\s+{re.escape(target_section)}\b', re.IGNORECASE
            )
            other_section_pattern = re.compile(r'\bsection\s+(\d+)\b', re.IGNORECASE)

            for i, chunk_text in enumerate(chunks_snapshot):
                chunk_stripped = chunk_text.strip()
                chunk_lower_s = chunk_stripped.lower()

                # Massive boost: chunk STARTS with the target section header
                if target_pattern.match(chunk_lower_s):
                    similarities[i] += 3.0
                # Large boost: target section header appears anywhere in the chunk
                elif target_pattern.search(chunk_lower_s):
                    similarities[i] += 2.0
                else:
                    # Penalize chunks that clearly belong to a DIFFERENT numbered section
                    other_matches = other_section_pattern.findall(chunk_lower_s)
                    if other_matches and target_section not in other_matches:
                        similarities[i] -= 0.5

        # 4. Hybrid Keyword Boost (Sparse Retrieval)
        # Extract meaningful keywords from the query.
        # Expanded stop-word list prevents words like "tell"/"give"/"show" from
        # corrupting phrase reconstruction.
        stop_words = {
            "the", "and", "for", "with", "from", "that", "this", "what",
            "where", "how", "who", "when", "why", "are", "you", "can",
            "tell", "give", "show", "about", "status", "document", "documents",
            "my", "is", "me", "its", "their", "a", "an", "in", "of", "to",
            "be", "do", "on", "at", "by", "up", "as", "it", "or", "was",
            "has", "had", "will", "just", "please", "get", "let", "know",
        }
        raw_words = re.findall(r'\b[a-zA-Z0-9-]+\b', query_lower)
        # Allow single-digit numbers (e.g. "1" in "section 1") as valid keywords
        keywords = [
            w for w in raw_words
            if (len(w) >= 3 or w.isdigit()) and w not in stop_words
        ]

        if keywords:
            # Build all consecutive sub-phrase candidates (length 2–4) from the
            # filtered keyword list — but ONLY include a candidate if that exact
            # string also appears in the original (lowercased) query.  This
            # prevents junk phrases like "tell section 1" from matching nothing.
            candidate_phrases: List[str] = []
            for n in range(2, min(len(keywords) + 1, 5)):
                for j in range(len(keywords) - n + 1):
                    phrase = " ".join(keywords[j : j + n])
                    if phrase in query_lower:
                        candidate_phrases.append(phrase)

            for i, chunk_text in enumerate(chunks_snapshot):
                chunk_lower_kw = chunk_text.lower()

                # a) Individual keyword matches (+0.3 each)
                matches = sum(1 for kw in keywords if kw in chunk_lower_kw)

                # b) Phrase matches (+1.0 per matching phrase)
                phrase_boost = sum(
                    1.0 for ph in candidate_phrases if ph in chunk_lower_kw
                )

                if matches > 0 or phrase_boost > 0:
                    similarities[i] += (matches * 0.3) + phrase_boost

        # 5. Get top-K indices (sorted descending)
        top_indices = np.argsort(similarities)[-top_k:][::-1]

        # 6. Filter by minimum similarity threshold to drop irrelevant chunks.
        # Raw cosine scores sit roughly in [0, 1]; keyword boosts push them higher.
        # A threshold of 0.30 keeps chunks that are genuinely on-topic while
        # discarding tangential sections that happen to share surface-level tokens.
        # For section-targeted queries, use a lower floor so the correct section
        # is always returned even when the semantic score alone is modest.
        min_sim = 0.10 if section_query_match else 0.30
        docs = [
            chunks_snapshot[i]
            for i in top_indices
            if similarities[i] >= min_sim
        ]

        if not docs:
            return None

        # Clean decorative lines from retrieved chunks before sending to LLM
        docs = [_clean_text(d) for d in docs]
        docs = [d for d in docs if d]  # drop any that became empty after cleaning

        return "\n\n---\n\n".join(docs) if docs else None
    except Exception as e:
        logger.error(f"[RAG] Retrieval failed: {e}")
        return None


def is_ready() -> bool:
    """Return True if the RAG index is loaded and ready to use."""
    return _rag_ready


# ── FAQ / Curated Answer Cache ────────────────────────────────────────────────
# Loaded at startup from the faq_entries DB table.
# Questions are embedded once; at query time we do a cosine-similarity check
# and return the stored answer directly if similarity ≥ FAQ_THRESHOLD.
_faq_lock = threading.Lock()
_faq_ids: List[int] = []
_faq_questions: List[str] = []
_faq_answers: List[str] = []
_faq_embeddings = None  # np.ndarray shape (N, dim) or None

FAQ_THRESHOLD = 0.72  # minimum cosine similarity to treat as a FAQ match


def load_faqs(entries: list) -> None:
    """
    Populate the in-memory FAQ cache from a list of (id, question, answer) tuples.
    Call this at startup after the embedding model is loaded.
    """
    global _faq_ids, _faq_questions, _faq_answers, _faq_embeddings

    if not entries:
        return

    if _embedding_model is None:
        logger.warning("[FAQ] Embedding model not ready — FAQ cache not loaded.")
        return

    ids, questions, answers = zip(*entries)
    embeddings = _embedding_model.encode(list(questions), convert_to_numpy=True)

    with _faq_lock:
        _faq_ids = list(ids)
        _faq_questions = list(questions)
        _faq_answers = list(answers)
        _faq_embeddings = embeddings

    logger.info(f"[FAQ] Loaded {len(ids)} curated Q&A entries into cache.")


def add_faq_to_cache(faq_id: int, question: str, answer: str) -> None:
    """Add a single FAQ entry to the in-memory cache."""
    global _faq_ids, _faq_questions, _faq_answers, _faq_embeddings

    if _embedding_model is None:
        return

    new_emb = _embedding_model.encode([question], convert_to_numpy=True)

    with _faq_lock:
        _faq_ids.append(faq_id)
        _faq_questions.append(question)
        _faq_answers.append(answer)
        if _faq_embeddings is None:
            _faq_embeddings = new_emb
        else:
            _faq_embeddings = np.vstack([_faq_embeddings, new_emb])

    logger.info(f"[FAQ] Added FAQ id={faq_id} to cache.")


def remove_faq_from_cache(faq_id: int) -> None:
    """Remove a FAQ entry from the in-memory cache by its DB id."""
    global _faq_ids, _faq_questions, _faq_answers, _faq_embeddings

    with _faq_lock:
        if faq_id not in _faq_ids:
            return
        idx = _faq_ids.index(faq_id)
        _faq_ids.pop(idx)
        _faq_questions.pop(idx)
        _faq_answers.pop(idx)
        if _faq_embeddings is not None and _faq_embeddings.shape[0] > 0:
            _faq_embeddings = np.delete(_faq_embeddings, idx, axis=0)
            if _faq_embeddings.shape[0] == 0:
                _faq_embeddings = None

    logger.info(f"[FAQ] Removed FAQ id={faq_id} from cache.")


def faq_lookup(query: str) -> Optional[str]:
    """
    Check if the query semantically matches any curated FAQ question.
    Returns the stored answer if similarity >= FAQ_THRESHOLD, else None.

    Section-number guard: if the query mentions "section N", only FAQ entries
    whose question also mentions "section N" are eligible — prevents "section 2"
    from matching a "section 3" FAQ entry even when their semantic scores are close.
    """
    global _faq_embeddings, _faq_answers, _faq_questions, _embedding_model

    if _embedding_model is None or _faq_embeddings is None or len(_faq_answers) == 0:
        return None

    try:
        from sklearn.metrics.pairwise import cosine_similarity as cos_sim

        with _faq_lock:
            emb_snapshot = _faq_embeddings.copy()
            answers_snapshot = list(_faq_answers)
            questions_snapshot = list(_faq_questions)

        query_emb = _embedding_model.encode([query], convert_to_numpy=True)
        sims = cos_sim(query_emb, emb_snapshot)[0]

        # Section-number guard: extract "section N" from query
        section_match = re.search(r'\bsection\s+(\d+)\b', query.lower())
        query_section_num = section_match.group(1) if section_match else None

        # Sort candidates by similarity descending and pick best eligible one
        ranked = sorted(enumerate(sims), key=lambda x: x[1], reverse=True)
        for idx, score in ranked:
            if score < FAQ_THRESHOLD:
                break  # remaining scores are all lower

            if query_section_num is not None:
                # Only accept this FAQ entry if its question has the SAME section number
                faq_section = re.search(r'\bsection\s+(\d+)\b', questions_snapshot[idx].lower())
                if not faq_section or faq_section.group(1) != query_section_num:
                    continue  # wrong section number — skip

            logger.info(f"[FAQ] Match found (score={score:.3f}) for query: '{query[:60]}'")
            return answers_snapshot[idx]

        return None
    except Exception as e:
        logger.error(f"[FAQ] Lookup failed: {e}")
        return None
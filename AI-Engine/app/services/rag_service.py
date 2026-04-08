import os
import re
import json
import logging
import requests
from typing import List, Optional
import numpy as np

logger = logging.getLogger(__name__)

# ── ChromaDB client & collections ─────────────────────────────────────────────
_chroma_client = None
_rag_collection = None       # stores document chunks
_faq_collection = None       # stores curated FAQ entries

# Lazy-loaded globals
_rag_ready: bool = False
_embedding_model = None
_store_dir: str = ""         # set during initialize_rag

_MAX_CHUNK_CHARS = 3000      # hard cap per chunk

# Matches lines that are 3+ repeated decorative characters (═══, ----, ====, etc.)
_DECO_LINE_RE = re.compile(r'^([═=\-_*~─━▬])\1{2,}$')

FAQ_THRESHOLD = 0.72         # minimum cosine similarity to treat as a FAQ match


# ── Text Processing Helpers ───────────────────────────────────────────────────

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
                current = para
        if current:
            chunks.append(current)

    return chunks


# ── ChromaDB Connection ───────────────────────────────────────────────────────

def _get_chroma_client():
    """Get or create the ChromaDB client (HTTP connection to the chroma container)."""
    global _chroma_client
    if _chroma_client is not None:
        return _chroma_client

    import chromadb

    chroma_host = os.environ.get("CHROMA_HOST", "localhost")
    chroma_port = int(os.environ.get("CHROMA_PORT", "8100"))

    logger.info(f"[RAG] Connecting to ChromaDB at {chroma_host}:{chroma_port}")
    _chroma_client = chromadb.HttpClient(host=chroma_host, port=chroma_port)
    
    # Verify connection with a heartbeat
    try:
        _chroma_client.heartbeat()
        logger.info("[RAG] ChromaDB connection established.")
    except Exception as e:
        logger.error(f"[RAG] ChromaDB connection failed: {e}")
        _chroma_client = None
        raise

    return _chroma_client


def _get_rag_collection():
    """Get or create the RAG document chunks collection."""
    global _rag_collection
    if _rag_collection is not None:
        return _rag_collection

    client = _get_chroma_client()
    _rag_collection = client.get_or_create_collection(
        name="rag_documents",
        metadata={"hnsw:space": "cosine"},
    )
    logger.info(f"[RAG] Collection 'rag_documents' ready ({_rag_collection.count()} chunks)")
    return _rag_collection


def _get_faq_collection():
    """Get or create the FAQ collection."""
    global _faq_collection
    if _faq_collection is not None:
        return _faq_collection

    client = _get_chroma_client()
    _faq_collection = client.get_or_create_collection(
        name="faq_entries",
        metadata={"hnsw:space": "cosine"},
    )
    logger.info(f"[RAG] Collection 'faq_entries' ready ({_faq_collection.count()} entries)")
    return _faq_collection


# ── Embedding Helper ──────────────────────────────────────────────────────────

def _embed(texts: List[str]) -> List[List[float]]:
    """Encode texts to embeddings using the sentence-transformer model."""
    global _embedding_model
    if _embedding_model is None:
        raise RuntimeError("[RAG] Embedding model not loaded. Call initialize_rag() first.")
    return _embedding_model.encode(texts, convert_to_numpy=True).tolist()


# ── Admin API Fetch ───────────────────────────────────────────────────────────

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


# ── Index Build / Load ────────────────────────────────────────────────────────

def _build_index_from_api(api_url: str) -> None:
    """
    Build the ChromaDB index from the Admin API documents.
    Only called when the collection is empty (first boot or after rebuild).
    """
    collection = _get_rag_collection()

    # If collection already has data, skip building
    if collection.count() > 0:
        logger.info(f"[RAG] Collection already has {collection.count()} chunks. Skipping build.")
        return

    logger.info(f"[RAG] Indexing all documents from {api_url} ...")
    doc_list = _fetch_all_from_api(api_url)

    if not doc_list:
        logger.warning("[RAG] No documents returned from API. RAG will start empty.")
        return

    all_chunks = []
    all_filenames = []
    for original_name, text in doc_list:
        doc_chunks = _chunk_text(text, chunk_size=500, overlap=100)
        all_chunks.extend(doc_chunks)
        all_filenames.extend([original_name] * len(doc_chunks))

    if not all_chunks:
        return

    # Embed and add to ChromaDB in batches (ChromaDB has a per-request limit)
    batch_size = 100
    for i in range(0, len(all_chunks), batch_size):
        batch_chunks = all_chunks[i:i + batch_size]
        batch_filenames = all_filenames[i:i + batch_size]
        batch_embeddings = _embed(batch_chunks)
        batch_ids = [f"chunk_{i + j}" for j in range(len(batch_chunks))]

        collection.add(
            ids=batch_ids,
            documents=batch_chunks,
            embeddings=batch_embeddings,
            metadatas=[{"filename": fn} for fn in batch_filenames],
        )

    logger.info(f"[RAG] Ready. {len(all_chunks)} chunks indexed from {len(doc_list)} documents.")


# ── Public API (same signatures as before) ────────────────────────────────────

def initialize_rag(api_url: str, store_dir: str) -> None:
    """
    Initialize the RAG index at application startup.
    Call this once from main.py lifespan so the index is ready before requests come in.
    """
    global _rag_ready, _store_dir, _embedding_model

    _store_dir = store_dir

    if not api_url:
        logger.warning("[RAG] No API URL provided. RAG disabled.")
        return

    try:
        # Load embedding model once
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

        # Connect to ChromaDB and build index if empty
        _build_index_from_api(api_url)
        _rag_ready = True
        logger.info("[RAG] Initialization complete.")
    except Exception as e:
        logger.error(f"[RAG] Failed to initialize: {e}")
        _rag_ready = False


def rebuild_index() -> int:
    """
    Force a full rebuild of the RAG index by fetching all documents from the Admin API.
    Returns the number of indexed chunks.
    """
    global _rag_ready, _embedding_model

    if not _store_dir:
        raise RuntimeError("[RAG] Store directory not set. Was initialize_rag called?")

    api_url = os.environ.get("RAG_DOCUMENT_API_URL", "http://localhost:3005/api/general-documents")

    logger.info(f"[RAG] Rebuilding index from {api_url} ...")

    # Delete and recreate collection to start fresh
    client = _get_chroma_client()
    try:
        client.delete_collection("rag_documents")
    except Exception:
        pass

    global _rag_collection
    _rag_collection = None  # force re-creation
    collection = _get_rag_collection()

    doc_list = _fetch_all_from_api(api_url)

    if not doc_list:
        _rag_ready = True  # ready but empty
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

    # Add in batches
    batch_size = 100
    for i in range(0, len(all_chunks), batch_size):
        batch_chunks = all_chunks[i:i + batch_size]
        batch_filenames = all_filenames[i:i + batch_size]
        batch_embeddings = _embed(batch_chunks)
        batch_ids = [f"rebuild_{i + j}" for j in range(len(batch_chunks))]

        collection.add(
            ids=batch_ids,
            documents=batch_chunks,
            embeddings=batch_embeddings,
            metadatas=[{"filename": fn} for fn in batch_filenames],
        )

    _rag_ready = True
    logger.info(f"[RAG] Rebuild complete. {len(all_chunks)} chunks indexed from {len(doc_list)} documents.")
    return len(all_chunks)


def add_document_to_index(text: str, filename: str = "unknown") -> int:
    """
    Ingest raw text from an uploaded document into the live RAG index.

    - Chunks the text using the same parameters as the initial build.
    - Generates embeddings and adds them to ChromaDB.

    Returns:
        Number of new chunks that were added.

    Raises:
        RuntimeError: If the embedding model is not yet loaded.
    """
    global _rag_ready

    if _embedding_model is None:
        raise RuntimeError("[RAG] Embedding model is not loaded. Call initialize_rag() first.")

    new_chunks = _chunk_text(text, chunk_size=500, overlap=100)
    if not new_chunks:
        logger.warning(f"[RAG] No chunks extracted from '{filename}'. Skipping.")
        return 0

    collection = _get_rag_collection()
    new_embeddings = _embed(new_chunks)

    # Generate unique IDs using filename + index
    import hashlib
    base_hash = hashlib.md5(filename.encode()).hexdigest()[:8]
    existing_count = collection.count()
    chunk_ids = [f"{base_hash}_{existing_count + i}" for i in range(len(new_chunks))]

    collection.add(
        ids=chunk_ids,
        documents=new_chunks,
        embeddings=new_embeddings,
        metadatas=[{"filename": filename}] * len(new_chunks),
    )

    _rag_ready = True
    logger.info(f"[RAG] Added {len(new_chunks)} chunks from '{filename}' to ChromaDB.")
    return len(new_chunks)


def delete_document_from_index(filename: str) -> int:
    """
    Remove all chunks and embeddings associated with a specific document filename.

    Returns:
        Number of chunks deleted.
    """
    if not _rag_ready:
        return 0

    collection = _get_rag_collection()

    # Query ChromaDB for all chunks belonging to this filename
    results = collection.get(
        where={"filename": filename},
        include=[],
    )

    if not results["ids"]:
        return 0

    count = len(results["ids"])
    collection.delete(ids=results["ids"])

    logger.info(f"[RAG] Deleted {count} chunks for '{filename}' from ChromaDB.")
    return count


def retrieve_context(query: str, top_k: int = 3) -> Optional[str]:
    """
    Retrieve the most relevant document chunks for a user query.

    Args:
        query: The user's question or message.
        top_k: How many chunks to return.

    Returns:
        A single string with the top-K chunks joined, or None if RAG is not ready.
    """
    if not _rag_ready or _embedding_model is None:
        return None

    collection = _get_rag_collection()
    if collection.count() == 0:
        return None

    try:
        query_lower = query.lower()

        # 1. Embed the query
        query_emb = _embed([query])

        # Request more results than needed so we can re-rank with keyword boosting
        fetch_k = min(top_k * 5, collection.count())

        results = collection.query(
            query_embeddings=query_emb,
            n_results=fetch_k,
            include=["documents", "distances", "metadatas"],
        )

        if not results["documents"] or not results["documents"][0]:
            return None

        docs = results["documents"][0]
        # ChromaDB returns distances (for cosine: distance = 1 - similarity)
        distances = results["distances"][0]
        similarities = [1.0 - d for d in distances]

        # 2. Section-targeted boosting
        section_query_match = re.search(r'\bsection\s+(\d+)\b', query_lower)
        if section_query_match:
            target_section = section_query_match.group(1)
            target_pattern = re.compile(
                rf'\bsection\s+{re.escape(target_section)}\b', re.IGNORECASE
            )
            other_section_pattern = re.compile(r'\bsection\s+(\d+)\b', re.IGNORECASE)

            for i, chunk_text in enumerate(docs):
                chunk_stripped = chunk_text.strip()
                chunk_lower_s = chunk_stripped.lower()

                if target_pattern.match(chunk_lower_s):
                    similarities[i] += 3.0
                elif target_pattern.search(chunk_lower_s):
                    similarities[i] += 2.0
                else:
                    other_matches = other_section_pattern.findall(chunk_lower_s)
                    if other_matches and target_section not in other_matches:
                        similarities[i] -= 0.5

        # 3. Hybrid Keyword Boost (Sparse Retrieval)
        stop_words = {
            "the", "and", "for", "with", "from", "that", "this", "what",
            "where", "how", "who", "when", "why", "are", "you", "can",
            "tell", "give", "show", "about", "status", "document", "documents",
            "my", "is", "me", "its", "their", "a", "an", "in", "of", "to",
            "be", "do", "on", "at", "by", "up", "as", "it", "or", "was",
            "has", "had", "will", "just", "please", "get", "let", "know",
        }
        raw_words = re.findall(r'\b[a-zA-Z0-9-]+\b', query_lower)
        keywords = [
            w for w in raw_words
            if (len(w) >= 3 or w.isdigit()) and w not in stop_words
        ]

        if keywords:
            candidate_phrases: List[str] = []
            for n in range(2, min(len(keywords) + 1, 5)):
                for j in range(len(keywords) - n + 1):
                    phrase = " ".join(keywords[j: j + n])
                    if phrase in query_lower:
                        candidate_phrases.append(phrase)

            for i, chunk_text in enumerate(docs):
                chunk_lower_kw = chunk_text.lower()

                matches = sum(1 for kw in keywords if kw in chunk_lower_kw)
                phrase_boost = sum(
                    1.0 for ph in candidate_phrases if ph in chunk_lower_kw
                )

                if matches > 0 or phrase_boost > 0:
                    similarities[i] += (matches * 0.3) + phrase_boost

        # 4. Re-rank by boosted similarity and take top_k
        ranked = sorted(range(len(docs)), key=lambda i: similarities[i], reverse=True)

        min_sim = 0.10 if section_query_match else 0.30
        result_docs = [
            docs[i]
            for i in ranked[:top_k]
            if similarities[i] >= min_sim
        ]

        if not result_docs:
            return None

        # Clean decorative lines from retrieved chunks before sending to LLM
        result_docs = [_clean_text(d) for d in result_docs]
        result_docs = [d for d in result_docs if d]

        return "\n\n---\n\n".join(result_docs) if result_docs else None
    except Exception as e:
        logger.error(f"[RAG] Retrieval failed: {e}")
        return None


def is_ready() -> bool:
    """Return True if the RAG index is loaded and ready to use."""
    return _rag_ready


# ── FAQ / Curated Answer Cache ────────────────────────────────────────────────
# Stored in a separate ChromaDB collection.
# Questions are embedded once; at query time we do a cosine-similarity check
# and return the stored answer directly if similarity ≥ FAQ_THRESHOLD.


def load_faqs(entries: list) -> None:
    """
    Populate the ChromaDB FAQ collection from a list of (id, question, answer) tuples.
    Call this at startup after the embedding model is loaded.
    """
    if not entries:
        return

    if _embedding_model is None:
        logger.warning("[FAQ] Embedding model not ready — FAQ cache not loaded.")
        return

    collection = _get_faq_collection()

    # Clear existing entries to reload fresh
    if collection.count() > 0:
        existing = collection.get(include=[])
        if existing["ids"]:
            collection.delete(ids=existing["ids"])

    ids_list, questions, answers = zip(*entries)
    embeddings = _embed(list(questions))

    # Add in batches
    batch_size = 100
    for i in range(0, len(ids_list), batch_size):
        batch_ids = [f"faq_{faq_id}" for faq_id in ids_list[i:i + batch_size]]
        batch_docs = list(questions[i:i + batch_size])
        batch_embs = embeddings[i:i + batch_size]
        batch_metas = [
            {"faq_id": int(faq_id), "question": q, "answer": a}
            for faq_id, q, a in zip(
                ids_list[i:i + batch_size],
                questions[i:i + batch_size],
                answers[i:i + batch_size],
            )
        ]

        collection.add(
            ids=batch_ids,
            documents=batch_docs,
            embeddings=batch_embs,
            metadatas=batch_metas,
        )

    logger.info(f"[FAQ] Loaded {len(ids_list)} curated Q&A entries into ChromaDB.")


def add_faq_to_cache(faq_id: int, question: str, answer: str) -> None:
    """Add a single FAQ entry to the ChromaDB FAQ collection."""
    if _embedding_model is None:
        return

    collection = _get_faq_collection()
    embedding = _embed([question])

    collection.upsert(
        ids=[f"faq_{faq_id}"],
        documents=[question],
        embeddings=embedding,
        metadatas=[{"faq_id": faq_id, "question": question, "answer": answer}],
    )

    logger.info(f"[FAQ] Added FAQ id={faq_id} to ChromaDB.")


def remove_faq_from_cache(faq_id: int) -> None:
    """Remove a FAQ entry from the ChromaDB FAQ collection by its DB id."""
    collection = _get_faq_collection()

    try:
        collection.delete(ids=[f"faq_{faq_id}"])
        logger.info(f"[FAQ] Removed FAQ id={faq_id} from ChromaDB.")
    except Exception:
        pass  # entry may not exist


def faq_lookup(query: str) -> Optional[str]:
    """
    Check if the query semantically matches any curated FAQ question.
    Returns the stored answer if similarity >= FAQ_THRESHOLD, else None.

    Section-number guard: if the query mentions "section N", only FAQ entries
    whose question also mentions "section N" are eligible.
    """
    if _embedding_model is None:
        return None

    collection = _get_faq_collection()
    if collection.count() == 0:
        return None

    try:
        query_emb = _embed([query])

        results = collection.query(
            query_embeddings=query_emb,
            n_results=min(10, collection.count()),
            include=["metadatas", "distances"],
        )

        if not results["metadatas"] or not results["metadatas"][0]:
            return None

        # Section-number guard
        section_match = re.search(r'\bsection\s+(\d+)\b', query.lower())
        query_section_num = section_match.group(1) if section_match else None

        for meta, distance in zip(results["metadatas"][0], results["distances"][0]):
            similarity = 1.0 - distance  # cosine distance → similarity

            if similarity < FAQ_THRESHOLD:
                continue

            if query_section_num is not None:
                faq_question = meta.get("question", "")
                faq_section = re.search(r'\bsection\s+(\d+)\b', faq_question.lower())
                if not faq_section or faq_section.group(1) != query_section_num:
                    continue

            logger.info(f"[FAQ] Match found (score={similarity:.3f}) for query: '{query[:60]}'")
            return meta.get("answer", "")

        return None
    except Exception as e:
        logger.error(f"[FAQ] Lookup failed: {e}")
        return None
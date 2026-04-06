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


def _chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> List[str]:
    """Split text into overlapping chunks for better retrieval coverage."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += chunk_size - overlap
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

        # 3. Hybrid Keyword Boost (Sparse Retrieval)
        # Extract meaningful keywords from the query (e.g., names, IDs, numbers)
        # Filter out common stop words
        stop_words = {"the", "and", "for", "with", "from", "that", "this", "what", "where", "how", "who", "when", "why", "are", "you", "can", "tell", "about", "status", "document", "documents", "my", "is"}
        raw_words = re.findall(r'\b[a-zA-Z0-9-]+\b', query.lower())
        # ALOW digits as keywords even if short, otherwise "Section 1" fails
        keywords = [w for w in raw_words if (len(w) >= 3 or w.isdigit()) and w not in stop_words]

        if keywords:
            query_lower = query.lower()
            # For each chunk, count how many unique keywords it contains
            for i, chunk_text in enumerate(chunks_snapshot):
                chunk_lower = chunk_text.lower()
                
                # a) Individual keyword matches
                matches = sum(1 for kw in keywords if kw in chunk_lower)
                
                # b) Big Boost: Phrase matching
                # If the exact sequence of keywords (ignoring stop words) appears in the chunk
                # example: "section 1"
                phrase = " ".join(keywords)
                phrase_boost = 1.0 if (len(keywords) > 1 and phrase in chunk_lower) else 0.0
                
                # Apply a significant boost per exact keyword match
                # Plus the phrase match boost
                if matches > 0 or phrase_boost > 0:
                    # +0.3 per keyword match + 1.0 for exact phrase
                    similarities[i] += (matches * 0.3) + phrase_boost
                    
        # 4. Get top-K indices (sorted descending)
        top_indices = np.argsort(similarities)[-top_k:][::-1]

        # 5. Fetch the actual text chunks
        docs = [chunks_snapshot[i] for i in top_indices]
        
        if not docs:
            return None
            
        return "\n\n---\n\n".join(docs)
    except Exception as e:
        logger.error(f"[RAG] Retrieval failed: {e}")
        return None


def is_ready() -> bool:
    """Return True if the RAG index is loaded and ready to use."""
    return _rag_ready
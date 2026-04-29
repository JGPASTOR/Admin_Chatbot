import asyncio
import hashlib
import os
import re
import json
import logging
import requests
from typing import List, Optional, Tuple
import numpy as np

from app.config import settings

logger = logging.getLogger(__name__)

# ── ChromaDB client & collections ─────────────────────────────────────────────
_chroma_client = None
_rag_collection = None       # stores document chunks
_faq_collection = None       # stores curated FAQ entries

# Lazy-loaded globals
_rag_ready: bool = False
_embedding_model = None
_store_dir: str = ""         # set during initialize_rag

# ── Chunking constants (Phase-1: smaller, overlapping chunks) ─────────────────
_CHUNK_SIZE    = 600   # chars per chunk (was 3000)
_CHUNK_OVERLAP = 150   # overlap between consecutive chunks
_MAX_CHUNK_CHARS = _CHUNK_SIZE  # kept for backward-compat references

# Matches lines that are 3+ repeated decorative characters (═══, ----, ====, etc.)
_DECO_LINE_RE = re.compile(r'^([═=\-_*~─━▬])\1{2,}$')

FAQ_THRESHOLD = 0.65         # minimum cosine similarity to treat as a FAQ match

# ── Redis cache (async) ───────────────────────────────────────────────────────
_redis = None          # set by connect_redis()
_RAG_CACHE_TTL = 900   # 15 minutes
_RAG_CACHE_PREFIX = "rag:query:"


async def connect_redis(redis_url: str) -> None:
    """Open async Redis connection for RAG query caching."""
    global _redis
    try:
        import redis.asyncio as aioredis
        _redis = aioredis.from_url(redis_url, decode_responses=True)
        await _redis.ping()
        logger.info("[RAG] Redis cache connected.")
    except Exception as e:
        logger.warning(f"[RAG] Redis connection failed — caching disabled: {e}")
        _redis = None


async def disconnect_redis() -> None:
    """Close the async Redis connection."""
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


def _make_rag_cache_key(query: str) -> str:
    """Stable cache key from the normalised query text."""
    digest = hashlib.sha256(query.lower().strip().encode()).hexdigest()
    return f"{_RAG_CACHE_PREFIX}{digest}"


async def invalidate_rag_cache() -> int:
    """Delete all rag:query:* keys. Call after any ingest / delete / rebuild."""
    if _redis is None:
        return 0
    deleted = 0
    try:
        cursor = 0
        while True:
            cursor, keys = await _redis.scan(cursor=cursor, match=f"{_RAG_CACHE_PREFIX}*", count=500)
            if keys:
                deleted += await _redis.delete(*keys)
            if cursor == 0:
                break
        logger.info(f"[RAG] Invalidated {deleted} cached RAG queries.")
    except Exception as e:
        logger.warning(f"[RAG] Cache invalidation error: {e}")
    return deleted


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


def _split_into_chunks(text: str, chunk_size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> List[str]:
    """
    Sliding-window character-based chunker with overlap.

    Parameters
    ----------
    chunk_size : int
        Maximum characters per chunk (default 600, Phase-1 value).
    overlap : int
        Characters shared between consecutive chunks (default 150, 25 %).

    Strategy
    --------
    1. Start each window at a paragraph/sentence boundary when possible
       so chunks don't begin mid-sentence.
    2. Slide the window forward by (chunk_size - overlap) characters.
    3. If we're mid-word at the end of a window, back up to the last space.
    """
    text = _clean_text(text)
    if not text:
        return []

    step = max(chunk_size - overlap, 1)
    chunks: List[str] = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = min(start + chunk_size, text_len)

        # If not at the end, try to snap to a sentence boundary ('. ', '\n')
        if end < text_len:
            snap = text.rfind('\n', start, end)
            if snap == -1 or (end - snap) > 200:
                snap = text.rfind('. ', start, end)
            if snap != -1 and snap > start:
                end = snap + 1  # include the delimiter

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        start += step

    return chunks


def _chunk_text(text: str, chunk_size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> List[str]:
    """
    Backward-compatible wrapper — delegates to _split_into_chunks.

    Legacy callers (build_index, rebuild_index, add_document_to_index,
    faq_generate endpoint) all call this function.
    """
    return _split_into_chunks(text, chunk_size=chunk_size, overlap=overlap)


# Pre-compiled pattern — matches "SECTION 3", "Section 3.", "Sec. 3", "Art. IV", "Article 5"
_SECTION_HEADER_RE = re.compile(
    r'\b(?:SECTION|Section|Sec\.?|ARTICLE|Article|Art\.?)\s+([\dIVXivx]+)',
    re.IGNORECASE,
)


def _detect_section(chunk: str) -> str:
    """
    Return a human-readable section label inferred from *chunk* text.

    Strategy (Phase-1 requirement: ``section`` metadata is always populated):
    1. Scan for a "Section N" / "Article N" header at or near the start of the chunk.
    2. Fall back to scanning the full chunk for any section reference.
    3. If nothing is found, return ``"General"``.
    """
    # Prefer matches near the beginning of the chunk (header lines)
    head = chunk[:300]
    m = _SECTION_HEADER_RE.search(head)
    if m:
        keyword = m.group(0).split()[0].title()  # e.g. "Section", "Article"
        num     = m.group(1).upper()              # e.g. "3", "IV"
        return f"{keyword} {num}"

    # Fall back to first match anywhere in the chunk
    m = _SECTION_HEADER_RE.search(chunk)
    if m:
        keyword = m.group(0).split()[0].title()
        num     = m.group(1).upper()
        return f"{keyword} {num}"

    return "General"


# ── ChromaDB Connection ───────────────────────────────────────────────────────

def _get_chroma_client():
    """Get or create the ChromaDB client (HTTP connection to the chroma container).
    
    Retries up to 5 times with exponential backoff to handle cases where
    ChromaDB is still starting up (depends_on: service_started doesn't
    guarantee the HTTP server is ready).
    """
    global _chroma_client
    if _chroma_client is not None:
        # Verify the existing client is still alive
        try:
            _chroma_client.heartbeat()
            return _chroma_client
        except Exception:
            logger.warning("[RAG] Existing ChromaDB connection lost — reconnecting...")
            _chroma_client = None

    import chromadb
    import time

    chroma_host = os.environ.get("CHROMA_HOST", "localhost")
    chroma_port = int(os.environ.get("CHROMA_PORT", "8000"))

    max_retries = 5
    for attempt in range(1, max_retries + 1):
        logger.info(f"[RAG] Connecting to ChromaDB at {chroma_host}:{chroma_port} (attempt {attempt}/{max_retries})")
        try:
            client = chromadb.HttpClient(host=chroma_host, port=chroma_port)
            client.heartbeat()
            _chroma_client = client
            logger.info("[RAG] ChromaDB connection established.")
            return _chroma_client
        except Exception as e:
            if attempt < max_retries:
                wait = 2 ** attempt  # 2, 4, 8, 16 seconds
                logger.warning(f"[RAG] ChromaDB connection failed (attempt {attempt}): {e} — retrying in {wait}s...")
                time.sleep(wait)
            else:
                logger.error(f"[RAG] ChromaDB connection failed after {max_retries} attempts: {e}")
                raise


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
    import os
    import httpx
    
    emb_url = os.environ.get("EMBEDDING_SERVICE_URL", "")
    if emb_url:
        try:
            res = httpx.post(f"{emb_url.rstrip('/')}/embed", json={"texts": texts, "normalize": True}, timeout=30)
            res.raise_for_status()
            return res.json().get("embeddings", [])
        except Exception as e:
            logger.error(f"[RAG] Fast embedding service failed: {e}")
            raise RuntimeError(f"[RAG] Embedding microservice failed: {e}")
            
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


# ── Location Sync ─────────────────────────────────────────────────────────────

_LOCATION_CAT_LABELS: dict = {
    "restaurant": "Restaurant",
    "shop": "Shop / Store",
    "tourist_spot": "Tourist Spot",
    "hotel": "Hotel / Accommodation",
    "hospital": "Hospital / Clinic",
    "government": "Government Office",
    "school": "School / University",
    "other": "Place of Interest",
}


def _location_to_text(loc: dict) -> str:
    """Convert a location row (from /api/locations) to a searchable text blob.

    Includes natural-language sentences alongside the metadata fields so that
    conversational queries like "where is X?" embed closer to the chunk.
    """
    cat_label = _LOCATION_CAT_LABELS.get(loc.get("category", ""), "Place")
    name = loc.get("name", "this location")

    lines = [f"{cat_label}: {name}"]
    if loc.get("category"):
        lines.append(f"Type: {cat_label}")
    if loc.get("address"):
        lines.append(f"Address: {loc['address']}")
        lines.append(f"{name} is located at {loc['address']}.")
    if loc.get("description"):
        lines.append(f"About: {loc['description']}")
    if loc.get("contact"):
        lines.append(f"Contact: {loc['contact']}")
        lines.append(f"Contact number of {name}: {loc['contact']}.")
    if loc.get("operating_hours"):
        lines.append(f"Operating Hours: {loc['operating_hours']}")
        lines.append(f"{name} is open {loc['operating_hours']}.")
    if loc.get("latitude") and loc.get("longitude"):
        lines.append(f"Coordinates: {loc['latitude']}, {loc['longitude']}")
    if loc.get("google_maps_url"):
        lines.append(f"Map: {loc['google_maps_url']}")
    return "\n".join(lines)


def _location_content_hash(loc: dict) -> str:
    """Stable MD5 hash of a location's mutable fields — used to detect stale RAG chunks."""
    fields = {k: loc.get(k, "") for k in (
        "name", "address", "description", "contact",
        "operating_hours", "category", "latitude", "longitude", "google_maps_url",
    )}
    return hashlib.md5(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def _ingest_location_faqs(loc: dict) -> int:
    """
    Generate structured Q&A pairs for a location and upsert them into the FAQ
    ChromaDB collection.  This gives mobile users asking short natural-language
    questions like "where is X?" or "saan ang X?" a fast FAQ-path hit instead
    of falling through to the slower RAG→LLM path.

    IDs are prefixed ``loc_faq_{loc_id}_`` so they never collide with regular
    FAQ entries and can be bulk-deleted when a location is removed/updated.
    """
    if _embedding_model is None:
        return 0

    loc_id = str(loc.get("id", ""))
    name = (loc.get("name") or "").strip()
    if not name or not loc_id:
        return 0

    cat_label = _LOCATION_CAT_LABELS.get(loc.get("category", ""), "Place").lower()

    # Build a full answer combining all available fields
    parts = [f"{name} is a {cat_label} in Surigao City."]
    if loc.get("address"):
        parts.append(f"Address: {loc['address']}.")
    if loc.get("description"):
        parts.append(loc["description"].strip())
    if loc.get("operating_hours"):
        parts.append(f"Operating hours: {loc['operating_hours']}.")
    if loc.get("contact"):
        parts.append(f"Contact: {loc['contact']}.")
    if loc.get("google_maps_url"):
        parts.append(f"Map: {loc['google_maps_url']}")
    full_answer = " ".join(parts)

    pairs: list = []  # (question, answer)

    # ── Where / address questions ────────────────────────────────────────────
    if loc.get("address"):
        addr = loc["address"]
        map_str = f" (Map: {loc['google_maps_url']})" if loc.get("google_maps_url") else ""
        loc_answer = f"{name} is located at {addr}.{map_str}"
        pairs += [
            (f"Where is {name}?", loc_answer),
            (f"Where is {name} located?", loc_answer),
            (f"What is the address of {name}?", loc_answer),
            (f"How to get to {name}?", loc_answer),
            (f"{name} address", loc_answer),
            (f"{name} location", loc_answer),
            # Tagalog variants (mobile users in Surigao often ask in Filipino)
            (f"Saan ang {name}?", loc_answer),
            (f"Nasaan ang {name}?", loc_answer),
        ]

    # ── Operating hours questions ────────────────────────────────────────────
    if loc.get("operating_hours"):
        hours = loc["operating_hours"]
        hours_answer = f"{name} is open {hours}."
        pairs += [
            (f"What are the operating hours of {name}?", hours_answer),
            (f"When is {name} open?", hours_answer),
            (f"What time does {name} open?", hours_answer),
            (f"{name} hours", hours_answer),
            (f"{name} open", hours_answer),
            # Tagalog
            (f"Anong oras bukas ang {name}?", hours_answer),
            (f"Kailan bukas ang {name}?", hours_answer),
        ]

    # ── Contact questions ────────────────────────────────────────────────────
    if loc.get("contact"):
        contact = loc["contact"]
        contact_answer = f"You can contact {name} at {contact}."
        pairs += [
            (f"What is the contact number of {name}?", contact_answer),
            (f"How do I contact {name}?", contact_answer),
            (f"{name} contact", contact_answer),
            (f"{name} phone number", contact_answer),
            # Tagalog
            (f"Contact number ng {name}?", contact_answer),
            (f"Numero ng {name}?", contact_answer),
        ]

    # ── General info questions ───────────────────────────────────────────────
    pairs += [
        (f"What is {name}?", full_answer),
        (f"Tell me about {name}.", full_answer),
        (f"What can you tell me about {name}?", full_answer),
        (f"{name}", full_answer),
        # Tagalog
        (f"Ano ang {name}?", full_answer),
    ]

    if not pairs:
        return 0

    collection = _get_faq_collection()
    questions = [p[0] for p in pairs]
    answers   = [p[1] for p in pairs]

    try:
        embeddings = _embed(questions)
        for i, (q, a, emb) in enumerate(zip(questions, answers, embeddings)):
            vid = f"loc_faq_{loc_id}_{i}"
            collection.upsert(
                ids=[vid],
                documents=[q],
                embeddings=[emb],
                metadatas=[{
                    "faq_id": vid,
                    "question": q,
                    "answer": a,
                    "location_id": loc_id,
                    "location_name": name,
                }],
            )
        logger.info(f"[RAG] Upserted {len(pairs)} FAQ entries for location '{name}'.")
        return len(pairs)
    except Exception as e:
        logger.error(f"[RAG] Failed to ingest location FAQs for '{name}': {e}")
        return 0


def _remove_location_faqs(loc_id: str) -> None:
    """Delete all FAQ collection entries that belong to a specific location."""
    try:
        collection = _get_faq_collection()
        existing = collection.get(include=[])
        ids_to_delete = [vid for vid in existing["ids"] if vid.startswith(f"loc_faq_{loc_id}_")]
        if ids_to_delete:
            collection.delete(ids=ids_to_delete)
            logger.info(f"[RAG] Removed {len(ids_to_delete)} FAQ entries for location id={loc_id}.")
    except Exception as e:
        logger.warning(f"[RAG] Failed to remove FAQ entries for location id={loc_id}: {e}")


def _ingest_locations_from_api(locations_api_url: str) -> int:
    """
    Fetch all locations from the Admin API and sync them into ChromaDB.

    Two-pronged sync per location:
    1. RAG collection  — plain text chunks for vector search fallback.
       Uses content-hash comparison so updated locations are re-ingested
       rather than silently keeping stale data.
    2. FAQ collection  — structured Q&A pairs (where is X?, hours of X?, etc.)
       stored via upsert so mobile users get a fast FAQ-path hit instead of
       going through the slower RAG→LLM pipeline.

    Returns the total number of *new* RAG chunks added.
    """
    if not locations_api_url:
        logger.warning("[RAG] _ingest_locations_from_api called with empty URL")
        return 0

    try:
        logger.info(f"[RAG] Fetching locations from {locations_api_url}")
        res = requests.get(locations_api_url, timeout=15)
        res.raise_for_status()
        data = res.json()
    except Exception as e:
        logger.warning(f"[RAG] Could not fetch locations from {locations_api_url}: {e}")
        raise RuntimeError(f"Could not fetch locations from Admin API: {e}")

    rows = data.get("data", [])
    if not rows:
        logger.info("[RAG] No locations found in Admin API.")
        return 0

    logger.info(f"[RAG] Found {len(rows)} location(s) from Admin API")

    collection = _get_rag_collection()

    # Read existing location metadata (filename + content_hash) from ChromaDB
    try:
        existing_meta = collection.get(include=["metadatas"])
        existing_filenames: set = set()
        existing_hashes: dict = {}
        for m in (existing_meta.get("metadatas") or []):
            fn = m.get("filename", "")
            existing_filenames.add(fn)
            if fn.startswith("location_") and fn not in existing_hashes:
                existing_hashes[fn] = m.get("content_hash", "")
    except Exception as e:
        logger.warning(f"[RAG] Could not read existing metadata: {e}")
        existing_filenames = set()
        existing_hashes = {}

    total_added = 0
    for loc in rows:
        loc_id   = str(loc.get("id", ""))
        loc_name = str(loc.get("name", "unknown")).replace(" ", "_")
        filename = f"location_{loc_id}_{loc_name}"
        new_hash = _location_content_hash(loc)

        # ── FAQ sync (always upsert — handles new + updated locations) ────────
        try:
            _ingest_location_faqs(loc)
        except Exception as e:
            logger.warning(f"[RAG] FAQ sync failed for '{loc.get('name')}': {e}")

        # ── RAG chunk sync ─────────────────────────────────────────────────────
        if filename in existing_filenames:
            stored_hash = existing_hashes.get(filename, "")
            if stored_hash == new_hash:
                logger.debug(f"[RAG] Location '{loc.get('name')}' unchanged — skipping RAG chunks.")
                continue
            # Content changed — remove stale chunks before re-ingesting
            delete_document_from_index(filename)
            logger.info(f"[RAG] Location '{loc.get('name')}' changed — re-ingesting RAG chunks.")

        text = _location_to_text(loc)
        chunks = _chunk_text(text)
        if not chunks:
            continue

        try:
            base_hash   = hashlib.md5(filename.encode()).hexdigest()[:8]
            start_count = collection.count()
            chunk_ids   = [f"{base_hash}_{start_count + i}" for i in range(len(chunks))]
            embeddings  = _embed(chunks)

            collection.add(
                ids=chunk_ids,
                documents=chunks,
                embeddings=embeddings,
                metadatas=[
                    {"filename": filename, "section": "General", "content_hash": new_hash}
                    for _ in chunks
                ],
            )
            total_added += len(chunks)
            logger.info(f"[RAG] Ingested location '{loc.get('name')}' — {len(chunks)} chunk(s).")
        except Exception as e:
            logger.error(f"[RAG] Failed to ingest location '{loc.get('name')}': {e}")
            continue

    logger.info(f"[RAG] Location sync complete. {total_added} new RAG chunk(s) from {len(rows)} locations.")
    return total_added


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
        doc_chunks = _chunk_text(text)  # uses global CHUNK_SIZE=600, OVERLAP=150
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
            metadatas=[
                {"filename": fn, "section": _detect_section(chunk)}
                for fn, chunk in zip(batch_filenames, batch_chunks)
            ],
        )

    logger.info(f"[RAG] Ready. {len(all_chunks)} chunks indexed from {len(doc_list)} documents.")


# ── Public API (same signatures as before) ────────────────────────────────────

def initialize_rag(api_url: str, store_dir: str, locations_api_url: str = "") -> None:
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
        import os
        emb_url = os.environ.get("EMBEDDING_SERVICE_URL", "")
        if emb_url:
            logger.info(f"[RAG] Phase 3: Utilizing Embedding Microservice at {emb_url}")
            _embedding_model = True # Mocking because we're using external service
        else:
            # Load embedding model once locally
            from sentence_transformers import SentenceTransformer
            _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

        # Mark ready as soon as the embedding model is available.
        # FAQ lookup works independently of the document index, so mobile
        # users get answers from ChromaDB even if document ingestion fails.
        _rag_ready = True
        logger.info("[RAG] Embedding model ready — FAQ lookup enabled.")
    except Exception as e:
        logger.error(f"[RAG] Failed to load embedding model: {e}")
        _rag_ready = False
        return

    try:
        # Connect to ChromaDB and build index if empty
        _build_index_from_api(api_url)
    except Exception as e:
        logger.warning(f"[RAG] Document index build failed (FAQ still works): {e}")

    logger.info("[RAG] Initialization complete.")



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
        doc_chunks = _chunk_text(text)  # uses global CHUNK_SIZE=600, OVERLAP=150
        all_chunks.extend(doc_chunks)
        all_filenames.extend([original_name] * len(doc_chunks))

    emb_url = os.environ.get("EMBEDDING_SERVICE_URL", "")
    if emb_url:
        _embedding_model = True
    elif _embedding_model is None:
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
            metadatas=[
                {"filename": fn, "section": _detect_section(chunk)}
                for fn, chunk in zip(batch_filenames, batch_chunks)
            ],
        )

    _rag_ready = True
    total = len(all_chunks)
    logger.info(f"[RAG] Rebuild complete. {total} total chunks indexed.")
    return total


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

    if not _rag_ready:
        raise RuntimeError("[RAG] RAG is not initialized. Call initialize_rag() first.")

    new_chunks = _chunk_text(text)  # uses global CHUNK_SIZE=600, OVERLAP=150
    if not new_chunks:
        logger.warning(f"[RAG] No chunks extracted from '{filename}'. Skipping.")
        return 0

    collection = _get_rag_collection()
    new_embeddings = _embed(new_chunks)

    # Generate unique IDs using filename + index
    base_hash = hashlib.md5(filename.encode()).hexdigest()[:8]
    existing_count = collection.count()
    chunk_ids = [f"{base_hash}_{existing_count + i}" for i in range(len(new_chunks))]

    collection.add(
        ids=chunk_ids,
        documents=new_chunks,
        embeddings=new_embeddings,
        metadatas=[
            {"filename": filename, "section": _detect_section(chunk)}
            for chunk in new_chunks
        ],
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


def _do_retrieve(query: str, top_k: int) -> Optional[str]:
    """
    Core (synchronous) ChromaDB retrieval with keyword boosting and re-ranking.
    Called by both retrieve_context (sync wrapper) and the async retrieve_parallel.
    """
    collection = _get_rag_collection()
    if collection.count() == 0:
        return None

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

    # 4. Location-chunk boost — when the query is asking about a place/spot,
    #    surface location_ chunks above generic document chunks.
    _LOCATION_QUERY_KW = {
        "where", "located", "location", "address", "find", "directions",
        "contact", "hours", "open", "closed", "spot", "place", "visit",
        "near", "saan", "nasa", "nasaan", "oras", "bukas", "numero",
    }
    if any(kw in query_lower for kw in _LOCATION_QUERY_KW):
        metadatas_list = results.get("metadatas", [[]])[0]
        for i, meta in enumerate(metadatas_list[:len(docs)]):
            if meta.get("filename", "").startswith("location_"):
                similarities[i] += 0.25

    # 5. Re-rank by boosted similarity and take top_k
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


def retrieve_context(query: str, top_k: int = 3) -> Optional[str]:
    """
    Synchronous public API: retrieve document chunks relevant to *query*.

    Checks the Redis cache first (rag:query:* keys, TTL 15 min).
    On a miss, runs the full ChromaDB vector search and caches the result.

    Returns a single string with the top-K chunks joined, or None.
    """
    if not _rag_ready or _embedding_model is None:
        return None

    # ── Try Redis cache (best-effort; never blocks on failure) ────────────────
    cache_key = _make_rag_cache_key(query)
    if _redis is not None:
        try:
            # Use asyncio.run_coroutine_threadsafe / get_event_loop trick only
            # when called from a sync context.  If we're inside an async context
            # the caller should use retrieve_context_async instead.
            loop = None
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                pass

            if loop is None:
                # Pure sync context — safe to use asyncio.run
                raw = asyncio.run(_redis.get(cache_key))
                if raw:
                    logger.debug(f"[RAG] Cache hit for key {cache_key[:32]}")
                    return json.loads(raw)
        except Exception:
            pass  # cache errors are non-fatal

    result = _do_retrieve(query, top_k)

    # ── Store in Redis (best-effort) ──────────────────────────────────────────
    if result is not None and _redis is not None:
        try:
            loop = None
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
            if loop is None:
                asyncio.run(_redis.setex(cache_key, _RAG_CACHE_TTL, json.dumps(result)))
        except Exception:
            pass

    return result


async def retrieve_context_async(query: str, top_k: int = 3) -> Optional[str]:
    """
    Async version of retrieve_context — Redis cache + ChromaDB via thread pool.

    Use this from async endpoints / conversation pipeline so the event loop
    is not blocked by the (synchronous) sentence-transformer encode call.
    """
    if not _rag_ready or _embedding_model is None:
        return None

    cache_key = _make_rag_cache_key(query)

    # ── Check Redis cache ─────────────────────────────────────────────────────
    if _redis is not None:
        try:
            raw = await _redis.get(cache_key)
            if raw:
                logger.debug(f"[RAG] Async cache hit for key {cache_key[:32]}")
                return json.loads(raw)
        except Exception:
            pass

    # ── Run synchronous ChromaDB retrieval in a thread ───────────────────────
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _do_retrieve, query, top_k)

    # ── Store result in Redis ─────────────────────────────────────────────────
    if result is not None and _redis is not None:
        try:
            await _redis.setex(cache_key, _RAG_CACHE_TTL, json.dumps(result))
        except Exception:
            pass

    return result


async def _faq_lookup_async(query: str) -> Optional[str]:
    """
    Async wrapper around the synchronous ChromaDB FAQ lookup.
    Runs the blocking call in an executor so it doesn't stall the event loop.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, faq_lookup, query)


async def retrieve_parallel(
    query: str,
    top_k: int = 3,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Fire FAQ lookup and RAG retrieval simultaneously with asyncio.gather.

    Returns
    -------
    (faq_answer, rag_context)
        faq_answer  — curated answer string if similarity >= FAQ_THRESHOLD, else None
        rag_context — joined chunk string from vector search, else None

    The caller should use faq_answer first; fall back to rag_context.
    Net latency = max(faq_time, rag_time) instead of their sum.
    """
    faq_answer, rag_context = await asyncio.gather(
        _faq_lookup_async(query),
        retrieve_context_async(query, top_k=top_k),
    )
    return faq_answer, rag_context


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

    # Clear existing REGULAR faq entries to reload fresh — but preserve
    # loc_faq_* entries created by _ingest_location_faqs() so location
    # Q&A pairs survive the reload cycle.
    if collection.count() > 0:
        existing = collection.get(include=[])
        if existing["ids"]:
            regular_ids = [
                vid for vid in existing["ids"]
                if not vid.startswith("loc_faq_")
            ]
            if regular_ids:
                collection.delete(ids=regular_ids)

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


def add_faq_question_variants(faq_id: int, variants: list, answer: str) -> None:
    """
    Add extra question phrasings for an existing FAQ entry into ChromaDB.
    Each variant gets its own ChromaDB document (id = faq_{faq_id}_var_{i})
    so the FAQ lookup can match broader rephrasing of the same question.
    """
    if _embedding_model is None or not variants:
        return

    collection = _get_faq_collection()
    clean = [v.strip() for v in variants if v and v.strip()]
    if not clean:
        return

    embeddings = _embed(clean)
    for i, (text, emb) in enumerate(zip(clean, embeddings)):
        vid = f"faq_{faq_id}_var_{i}"
        collection.upsert(
            ids=[vid],
            documents=[text],
            embeddings=[emb],
            metadatas=[{"faq_id": faq_id, "question": text, "answer": answer}],
        )

    logger.info(f"[FAQ] Added {len(clean)} question variants for FAQ id={faq_id}.")


def remove_faq_from_cache(faq_id: int) -> None:
    """Remove a FAQ entry (and all its variants) from the ChromaDB FAQ collection."""
    collection = _get_faq_collection()

    try:
        # Delete main entry
        collection.delete(ids=[f"faq_{faq_id}"])
    except Exception:
        pass

    # Delete any variant entries (faq_{id}_var_0, faq_{id}_var_1, ...)
    try:
        existing = collection.get(include=[])
        variant_ids = [vid for vid in existing["ids"] if vid.startswith(f"faq_{faq_id}_var_")]
        if variant_ids:
            collection.delete(ids=variant_ids)
    except Exception:
        pass

    logger.info(f"[FAQ] Removed FAQ id={faq_id} and its variants from ChromaDB.")


def faq_lookup(query: str) -> Optional[str]:
    """
    Check if the query semantically matches any curated FAQ question.
    Returns the stored answer if similarity >= FAQ_THRESHOLD, else None.

    Section-number handling: if the query mentions "section N", entries whose
    question also mentions "section N" get a +0.10 boost; entries that mention
    a *different* section get a -0.15 penalty. No hard-skip — avoids missing
    FAQs whose question text doesn't include the section number explicitly.
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

        # Section-number guard (soft — penalises mismatches, does NOT hard-skip)
        # Hard-skipping caused FAQs without "Section N" in the question text to be
        # completely invisible even when the user explicitly asked about that section.
        section_match = re.search(r'\bsection\s+(\d+)\b', query.lower())
        query_section_num = section_match.group(1) if section_match else None

        best_answer = None
        best_score = -1.0

        for meta, distance in zip(results["metadatas"][0], results["distances"][0]):
            similarity = 1.0 - distance  # cosine distance → similarity

            if similarity < FAQ_THRESHOLD:
                continue

            # Soft section-number signal — boosts exact match, lightly penalises
            # wrong section.  NOT a hard gate: a -0.10 nudge should not eliminate
            # a 0.75 match just because the user mentioned "section 3".
            if query_section_num is not None:
                faq_question = meta.get("question", "")
                faq_section = re.search(r'\bsection\s+(\d+)\b', faq_question.lower())
                if faq_section and faq_section.group(1) == query_section_num:
                    similarity += 0.10  # boost exact section match
                elif faq_section:
                    similarity -= 0.10  # gentle nudge down for wrong section (was -0.15)
            # ── No second threshold gate here ─────────────────────────────────
            # The section penalty is a preference signal, not a disqualifier.
            # We pick the highest-scoring entry that cleared the initial gate.

            if similarity > best_score:
                best_score = similarity
                best_answer = meta.get("answer", "")

        if best_answer is not None:
            logger.info(f"[FAQ] Match found (score={best_score:.3f}) for query: '{query[:60]}'")
            return best_answer

        return None
    except Exception as e:
        logger.error(f"[FAQ] Lookup failed: {e}")
        return None


def is_faq_duplicate(question: str, threshold: float = 0.85) -> bool:
    """
    Sync semantic dedup check — returns True if a very similar FAQ already exists.
    Used by both routes.py and the auto-cache pipeline in conversation.py.

    Thresholds:
      >= 0.80  → almost certainly the same question → skip insert
      0.65–0.80 → related but distinct phrasing → allow (variant coverage)
      < 0.65   → unique → definitely insert
    """
    if _embedding_model is None:
        return False
    try:
        faq_col = _get_faq_collection()
        if faq_col.count() == 0:
            return False
        emb = _embed([question])
        results = faq_col.query(
            query_embeddings=emb,
            n_results=min(5, faq_col.count()),
            include=["distances"],
        )
        if results["distances"] and results["distances"][0]:
            best_sim = 1.0 - results["distances"][0][0]
            if best_sim >= threshold:
                logger.info(f"[DedupFAQ] Duplicate (sim={best_sim:.3f}) for: '{question[:60]}'")
                return True
    except Exception as e:
        logger.warning(f"[DedupFAQ] Check failed: {e}")
    return False


def store_faq_variants_sync(faq_id: int, question: str, answer: str, llm_url: str, n: int = 4) -> None:
    """
    Sync helper: call the LLM service to generate N alternate phrasings of *question*
    and store them in the FAQ ChromaDB collection so short/varied user queries also match.

    Called from both BackgroundTasks (routes.py) and asyncio run_in_executor
    (conversation.py auto-cache).  Uses httpx sync so it's safe in any context.
    """
    import httpx as _httpx
    import json as _json

    system = (
        "You generate alternative phrasings of a question. "
        f"Return ONLY a valid JSON array of {n} question strings — no markdown, no explanation."
    )
    prompt = (
        f"Original question: {question}\n\n"
        f"Generate {n} different ways a person might ask this exact same question. "
        "Include 1-2 very short (3-5 word) versions AND 1-2 full sentence versions. "
        f"Return a JSON array of exactly {n} strings."
    )
    try:
        res = _httpx.post(
            f"{llm_url}/api/generate",
            json={"prompt": prompt, "system_prompt": system},
            timeout=30,
        )
        res.raise_for_status()
        raw = res.json().get("response", "").strip()
        # Strip markdown code fences if present
        raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("` \n")
        m = re.search(r'\[[\s\S]*?\]', raw)
        variants = _json.loads(m.group(0) if m else raw)
        if isinstance(variants, list):
            variants = [str(v).strip() for v in variants if v and str(v).strip() and str(v).strip() != question][:n]
            if variants:
                add_faq_question_variants(faq_id, variants, answer)
                logger.info(f"[Variants] Stored {len(variants)} variants for FAQ id={faq_id}.")
    except Exception as e:
        logger.warning(f"[Variants] Failed for FAQ id={faq_id}: {e}")
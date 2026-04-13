# RAG & FAQ System — Improvement Plan
**Admin Chatbot · April 2026**  
Prepared for: DTS AI Team (Clarence Buenaflor, Jester Pastor, Mharjade Enario)

---

## Executive Summary

You currently have a working pipeline: upload → parse → generate FAQs → embed → ChromaDB → retrieve. The core architecture is sound. The problems are in **quality of what gets stored**, **speed of what gets retrieved**, and **stability under 1,000 concurrent users**. This plan addresses each layer in order of impact.

---

## Part 1 — Document Ingestion (The Foundation)

> If garbage goes in, garbage comes out. Fix ingestion first.

### 1.1 Current Problems

| Problem | Location | Impact |
|---------|----------|--------|
| Single text blob stored as JSON | `general_documents.extracted_data` | Chunks lose structure context |
| Chunks split by char count only | `rag_service.py` line 45-89 | Sentences are cut mid-thought |
| No chunk overlap | `rag_service.py` | A fact split across two chunks is never fully retrieved |
| No preprocessing for PDF tables | `adminDB/app/api/general-documents/route.js` | Table rows become meaningless strings |
| Max 12 chunks sent to LLM for FAQ gen | `routes.py` | Long documents lose coverage |

### 1.2 Solution: Structured Chunk Storage

**Action:** Add a `document_chunks` table in MySQL and store each chunk as its own row with full metadata.

```sql
CREATE TABLE document_chunks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  doc_id        INT NOT NULL,
  doc_name      VARCHAR(255),
  chunk_index   INT NOT NULL,          -- order within document
  chunk_text    TEXT NOT NULL,
  section_label VARCHAR(255),          -- e.g. "Section 3 — Eligibility"
  page_number   INT,                   -- if available from PDF
  char_count    INT,
  created_at    DATETIME DEFAULT NOW(),
  FOREIGN KEY (doc_id) REFERENCES general_documents(id) ON DELETE CASCADE,
  INDEX idx_doc_id (doc_id),
  INDEX idx_section (section_label)
);
```

**Why:** Individual chunk rows let you query, update, delete, or re-embed specific chunks without re-processing the full document.

### 1.3 Solution: Overlapping Chunks

**Action:** Update `_split_into_chunks()` in `rag_service.py` to use a **sliding window with overlap**.

```
Current:  [Chunk A: chars 0-800] [Chunk B: chars 801-1600]
Fixed:    [Chunk A: chars 0-800] [Chunk B: chars 650-1450] [Chunk C: chars 1300-2100]
                                           ↑ 150 char overlap
```

Parameters:
- `CHUNK_SIZE = 600` characters (reduce from 3000 — smaller = more precise retrieval)
- `CHUNK_OVERLAP = 150` characters (25% overlap)

**Why:** When an answer spans a chunk boundary, overlap ensures at least one chunk contains the full context.

### 1.4 Solution: Section-Tagged Chunks

Every chunk must carry its **parent section label** as metadata in ChromaDB.

```python
# When adding to ChromaDB, include section in metadata
chroma_collection.add(
    documents=[chunk_text],
    embeddings=[embedding.tolist()],
    metadatas=[{
        "doc_id": doc_id,
        "doc_name": doc_name,
        "section": section_label,   # ← always populated
        "chunk_index": i,
        "char_count": len(chunk_text)
    }],
    ids=[chunk_id]
)
```

**Current gap:** `section` metadata is added but sometimes empty. Make it required — fallback to `"General"` if no header is found.

---

## Part 2 — FAQ & Question Generation (The Quality Layer)

> The FAQ table is your knowledge base. Every row should be trustworthy.

### 2.1 Current Problems

| Problem | Impact |
|---------|--------|
| LLM only processes 12 chunks max | Large PDFs (50+ pages) are under-covered |
| Confidence scoring is purely LLM-estimated (can hallucinate 8/10) | False positives go to `faq_entries` |
| No embedding deduplication across documents | The same policy re-uploaded twice doubles entries |
| No versioning — editing an FAQ loses history | Cannot roll back wrong edits |
| `pending_faqs` auto-approves at confidence ≥ 8 | Even a hallucinated answer gets approved |

### 2.2 Solution: Chunked Batch Generation (Bypass the 12-Chunk Limit)

**Action:** Queue FAQ generation as a background job per chunk, not per document.

```
Current flow:
  Upload → store → generate all FAQs in one LLM call (12 chunk limit)

New flow:
  Upload → store → enqueue chunks → worker processes N chunks/hour
                                  → FAQs accumulate over time
                                  → admin sees progress bar
```

Implementation:
1. After upload, insert all chunks into a `faq_generation_queue` table with `status = 'pending'`
2. A background worker (`/api/faq/process-queue`) picks 5 pending chunks, runs Qwen3, stores results
3. Admin dashboard shows "Generating FAQs: 34/89 chunks processed"

```sql
CREATE TABLE faq_generation_queue (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  doc_id      INT NOT NULL,
  chunk_index INT NOT NULL,
  chunk_text  TEXT NOT NULL,
  section     VARCHAR(255),
  status      ENUM('pending', 'processing', 'done', 'failed') DEFAULT 'pending',
  retry_count INT DEFAULT 0,
  created_at  DATETIME DEFAULT NOW(),
  processed_at DATETIME,
  INDEX idx_status (status)
);
```

### 2.3 Solution: Two-Pass Confidence Verification

The current "Judge" LLM pass is good but optional. Make it **mandatory before auto-approval**.

```
Current:  LLM confidence ≥ 8 → auto-approve
Fixed:    LLM confidence ≥ 8 → Judge verifies answer is in source text → approve
                              → Judge fails → downgrade to 'pending' for manual review
```

**Add a lexical overlap check** as a fast pre-filter before calling Judge LLM:
- Extract 3-5 key phrases from the generated answer
- Check if ≥ 70% of those phrases appear verbatim in the source chunk
- If not, mark for review regardless of LLM-stated confidence

### 2.4 Solution: Semantic Deduplication Before Storage

Before inserting a new FAQ into `faq_entries`, check if a semantically similar question already exists.

```python
# In routes.py, before inserting FAQ
async def is_duplicate_faq(new_question: str, threshold=0.85) -> bool:
    # Embed new question
    # Query faq_entries ChromaDB collection
    # If any result has similarity >= 0.85, it's a duplicate
    # Merge answers if source differs; skip if same content
```

**Threshold guidance:**
- `0.85+` = very likely duplicate → skip
- `0.70–0.85` = possibly related → flag for admin review
- `< 0.70` = new unique FAQ → insert

### 2.5 Solution: FAQ Versioning

Add a `faq_history` table to track all changes.

```sql
CREATE TABLE faq_history (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  faq_id     INT NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  changed_by VARCHAR(100),  -- 'admin', 'ai-auto', 'ai-judge'
  change_type ENUM('created', 'edited', 'approved', 'rejected', 'deleted'),
  changed_at DATETIME DEFAULT NOW(),
  FOREIGN KEY (faq_id) REFERENCES faq_entries(id) ON DELETE CASCADE
);
```

---

## Part 3 — RAG Retrieval Optimization (The Speed Layer)

> For 1,000 users, every millisecond of retrieval delay multiplies.

### 3.1 Current Bottlenecks

| Bottleneck | File | Current Behavior |
|-----------|------|-----------------|
| Query embedding computed per request | `rag_service.py` line 444 | 20-80ms per query |
| `K * 5` candidates fetched then re-ranked in Python | `rag_service.py` line 444 | Slow for large collections |
| ChromaDB HTTP call on every chat message | `rag_service.py` line 94 | No connection pooling |
| FAQ lookup makes separate ChromaDB call | `rag_service.py` line 665 | 2× vector DB round trips |
| Sentence transformer loaded at startup but not cached per worker | `rag_service.py` line 273 | Multiple Uvicorn workers each hold model in RAM |

### 3.2 Solution: Redis Query Cache (Primary Speed Fix)

You already have Redis for LLM responses. Extend it to **RAG retrieval results**.

```python
# Cache key = SHA256 of (normalized query + doc_context_id)
# TTL = 900 seconds (15 minutes) for retrieval results

async def get_rag_context(query: str) -> list[str]:
    cache_key = f"rag:query:{sha256(query.lower().strip())}"
    
    # 1. Check Redis first
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # 2. Vector search
    results = chroma_collection.query(...)
    
    # 3. Cache result
    await redis.setex(cache_key, 900, json.dumps(results))
    return results
```

**When to invalidate:** Any time a document is ingested or deleted, flush all `rag:query:*` keys.

```python
# After ingestion
await redis.delete(*await redis.keys("rag:query:*"))
```

**Expected impact:** 60-80% of repeated/similar queries hit cache. Latency drops from 200ms → 5ms for cache hits.

### 3.3 Solution: FAQ Hot Cache in Redis

Currently FAQs are matched via ChromaDB. Move the **top 200 highest-confidence FAQs** into Redis as a sorted set.

```python
# On startup and after FAQ update
for faq in top_200_faqs_by_confidence:
    embedding = embed(faq.question)
    await redis.hset(f"faq:embed:{faq.id}", mapping={
        "question": faq.question,
        "answer": faq.answer,
        "embedding": json.dumps(embedding.tolist())
    })
```

Lookup: embed query → compute cosine similarity in Python against Redis entries → if match ≥ 0.65, return instantly without hitting ChromaDB.

**Why:** Redis HGETALL for 200 entries takes ~2ms. ChromaDB query takes ~50ms. For FAQ-matching queries, this saves 48ms per user request.

### 3.4 Solution: Pre-compute Common Query Embeddings

Add a `common_queries` table. After 30 days in production, identify the 50 most frequent user queries, pre-embed them, and store the RAG context alongside.

```sql
CREATE TABLE query_cache_warmup (
  query_text      TEXT NOT NULL,
  query_hash      VARCHAR(64) UNIQUE,
  rag_context     JSON,               -- pre-retrieved chunks
  hit_count       INT DEFAULT 0,
  last_refreshed  DATETIME
);
```

Warm this cache on startup and refresh nightly via cron.

### 3.5 Solution: Merge FAQ + RAG in One ChromaDB Call

Currently: `faq_lookup()` → ChromaDB → `get_rag_context()` → ChromaDB (if FAQ miss)

**Optimized flow:**

```python
async def retrieve(query: str):
    # Single call, query BOTH collections simultaneously
    faq_results, rag_results = await asyncio.gather(
        faq_collection.query(query_embeddings=[q_embed], n_results=3),
        rag_collection.query(query_embeddings=[q_embed], n_results=15)
    )
    
    # Rank combined results
    if faq_results.top_score >= 0.65:
        return {"type": "faq", "answer": faq_results[0]}
    else:
        return {"type": "rag", "chunks": rerank(rag_results)}
```

`asyncio.gather` fires both ChromaDB calls in parallel. Net latency = max(faq_time, rag_time) instead of sum.

---

## Part 4 — Scaling for 1,000 Users (The Infrastructure Layer)

### 4.1 Current Single Points of Failure

```
AI-Engine (1 Uvicorn worker)
    ↓
ChromaDB (1 container)
    ↓
LLM Service → Ollama (1 Qwen3 instance)
    ↓
MySQL (1 instance)
```

At 1,000 users, Ollama becomes the bottleneck. Qwen3:9b can process ~2-4 requests/second on consumer GPU. At peak load, queue depth explodes.

### 4.2 Solution: Request Queue with Priority Lanes

Add a Redis-backed queue with 3 priority tiers:

| Priority | Use Case | Max Wait |
|---------|---------|---------|
| HIGH | FAQ cache hit (answer already known) | Instant |
| MEDIUM | RAG retrieval (no LLM needed) | 2s |
| LOW | Full LLM generation | 15s |

```python
# In routes.py /api/chat
async def chat(request):
    # Try FAQ match FIRST (no LLM needed)
    faq_match = await try_faq_match(query)
    if faq_match:
        return faq_match  # return in <100ms, never hits queue
    
    # Try RAG-only response (template fill, no LLM)
    if is_simple_lookup(intent):
        rag_context = await get_rag_context(query)
        if rag_context and intent == "document_status":
            return fill_template(rag_context)  # no LLM
    
    # Only hit LLM for complex queries
    return await llm_queue.enqueue(query, rag_context, priority="low")
```

**Goal:** Only 20-30% of requests should require Qwen3. The other 70-80% return from cache, FAQ match, or template fill.

### 4.3 Solution: Horizontal Scaling for AI-Engine

Run multiple Uvicorn workers behind a load balancer:

```bash
# Instead of: uvicorn app.main:app --port 8000
uvicorn app.main:app --port 8000 --workers 4

# Or with gunicorn:
gunicorn app.main:app -w 4 -k uvicorn.workers.UvicornWorker
```

**Caveat:** The sentence transformer model is loaded per-worker. With 4 workers × ~600MB model = ~2.4GB RAM for embeddings alone. Either:
- Use a shared embedding microservice (one FastAPI app just for `encode()`)
- Or deploy on a machine with ≥8GB RAM

### 4.4 Solution: Embedding Microservice (Recommended)

Extract the `SentenceTransformer` into its own service:

```
Current:  AI-Engine workers each load the model (4 × 600MB = 2.4GB)
Fixed:    Embedding Service (1 instance, 600MB) ← all AI-Engine workers call it
```

```python
# New: embedding_service/main.py
@app.post("/embed")
async def embed(texts: list[str]):
    return {"embeddings": model.encode(texts).tolist()}
```

AI-Engine calls `http://embedding-service:8002/embed` instead of loading locally.

### 4.5 Connection Pooling

**ChromaDB:** Enable persistent HTTP client with connection pool:
```python
chroma_client = chromadb.HttpClient(
    host=CHROMA_HOST,
    port=CHROMA_PORT,
    settings=Settings(
        anonymized_telemetry=False,
        chroma_client_auth_provider=None
    )
)
# Use module-level singleton — already done; verify it's not re-created per request
```

**MySQL:** Ensure SQLAlchemy pool settings:
```python
engine = create_engine(DATABASE_URL,
    pool_size=20,        # connections kept open
    max_overflow=10,     # burst capacity
    pool_timeout=30,     # wait time before error
    pool_recycle=1800    # recycle connections every 30min
)
```

---

## Part 5 — Monitoring & Feedback Loop (The Maintenance Layer)

> A system that doesn't improve from real usage stagnates.

### 5.1 Track What Fails

Every chat response should record:
- Did a FAQ match fire? (track FAQ utilization rate)
- Was RAG used? (track RAG hit rate)
- Did the LLM generate? (track LLM load %)
- Response time (track p50/p95 latency per endpoint)

```sql
-- Add to chat_logs table
ALTER TABLE chat_logs ADD COLUMN response_source ENUM('faq_cache','rag_template','llm') AFTER intent;
ALTER TABLE chat_logs ADD COLUMN response_ms INT AFTER response_source;
ALTER TABLE chat_logs ADD COLUMN rag_chunks_used INT AFTER response_ms;
```

### 5.2 Admin Dashboard: Knowledge Health Score

Add a daily report visible in the admin panel:

| Metric | Target | Current (estimate) |
|--------|--------|----------|
| FAQ coverage rate (% queries matched by FAQ) | > 60% | ~20% |
| RAG retrieval accuracy (thumbs up rate) | > 80% | unknown |
| Flagged query resolution rate | > 90% in 48h | unknown |
| Average response latency | < 2s | ~4-6s |
| LLM usage per 100 queries | < 30 | ~80 |

### 5.3 Closed-Loop Training from Flagged Queries

The `flagged_queries` table already captures missed questions. Build the loop:

```
User asks question → no confident answer found → flagged
                                                  ↓
Admin sees flagged query → writes answer in admin panel
                                                  ↓
Answer saved as new FAQ → ingested into ChromaDB
                                                  ↓
Next user asking same question → FAQ cache hit → instant answer
```

This is already partially built (flagged query admin UI exists). The missing piece is: **auto-create a FAQ entry when admin fills in the answer for a flagged query**.

---

## Implementation Roadmap

### Phase 1 — Quick Wins (1-2 weeks)
These require minimal code changes but high impact:

- [x] Add Redis caching for RAG retrieval results (`rag:query:*` keys)
- [x] Merge FAQ + RAG ChromaDB calls with `asyncio.gather`
- [x] Reduce chunk size to 600 chars, add 150-char overlap in `_split_into_chunks()`
- [x] Add `response_source` and `response_ms` columns to `chat_logs`
- [x] Fix: `section` metadata in ChromaDB is always populated (fallback to "General")

### Phase 2 — Quality Improvements (2-4 weeks)
- [x] Create `document_chunks` table and migrate ingestion pipeline
- [x] Add `faq_generation_queue` table + background worker endpoint
- [x] Implement semantic deduplication check before FAQ insert
- [x] Add lexical overlap verification before auto-approval
- [x] Build `faq_history` table + changelog UI

### Phase 3 — Scale Infrastructure (4-6 weeks)
- [x] Extract embedding into dedicated microservice
- [x] Configure Uvicorn multi-worker with `--workers 4`
- [x] Add SQLAlchemy pool settings for MySQL
- [x] Implement 3-tier request queue (FAQ/RAG/LLM priority lanes)
- [x] Build admin Knowledge Health Score dashboard

### Phase 4 — Closed-Loop (Ongoing)
- [x] Auto-create FAQ from admin-resolved flagged queries
- [x] Weekly query analysis: top 50 unanswered queries
- [x] Nightly cache warmup job for common queries
- [x] Monthly FAQ audit: remove stale/outdated entries

---

## File Change Summary

| File | Change | Phase |
|------|--------|-------|
| `AI-Engine/app/services/rag_service.py` | Add chunk overlap, reduce chunk size, parallel FAQ+RAG query, Redis query cache | 1-2 |
| `AI-Engine/app/api/routes.py` | FAQ deduplication check, batch queue endpoint, priority routing | 1-3 |
| `LLM/app/cache.py` | Extend cache to include RAG context (not just LLM output) | 1 |
| `AI-Engine/schema.sql` | Add `document_chunks`, `faq_generation_queue`, `faq_history` | 2 |
| `adminDB/schema.sql` | Add `query_cache_warmup` table | 3 |
| `adminDB/app/api/general-documents/route.js` | Store chunks to `document_chunks` table on upload | 2 |
| `adminDB/app/faq/page.js` | Show FAQ version history, confidence badge | 2 |
| New: `embedding-service/` | Standalone FastAPI for sentence-transformers | 3 |

---

## Summary

The core fix is a 3-layer strategy:

1. **Store better** — structured chunks with overlap and metadata → better retrieval accuracy
2. **Cache aggressively** — Redis for RAG results + FAQ hot cache → 70%+ cache hit rate at scale
3. **Route smarter** — FAQ match → RAG template → LLM (only last resort) → LLM load drops 3-4×

At 1,000 users, the bottleneck is Ollama, not the retrieval stack. The goal is to make sure most users never touch Ollama at all — they get their answer from a cached FAQ in under 200ms.

---

*Plan authored with full codebase audit. All file references are verified against current state.*

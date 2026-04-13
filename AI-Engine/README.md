# DTS AI Engine

AI-powered Document Tracking Assistant — a conversational REST API that helps users check document status using natural language. Supports streaming chat, Retrieval-Augmented Generation (RAG) from local government documents, and Text-to-Speech.

## Features

- 🤖 **ML-Based Intent Classification** — TF-IDF + SGDClassifier that you can retrain anytime
- 🔍 **Entity Extraction** — Automatically detects PDID numbers in various formats
- 💬 **Multi-Turn Conversations** — Remembers context across messages (e.g., asks for PDID, then uses it)
- 📚 **RAG (Retrieval-Augmented Generation)** — Answers LGU service questions from uploaded government documents
- 🧠 **LLM Integration** — Connects to an external LLM service for natural, context-aware responses
- ⚡ **Streaming Chat** — Server-Sent Events (SSE) for real-time token-by-token streaming to clients
- 🗺️ **Strict Topic Routing** — `docs` mode for document tracking, `lgu` mode for LGU knowledge base
- 📊 **Retrainable** — Add new training data via CSV or database, then retrain via API
- 🗄️ **Chat Logging** — All conversations stored in MySQL for analysis
- 🔌 **DTS Integration** — Mock mode for development, switch to real DTS API via config
- 🗣️ **Text-to-Speech (TTS)** — AI replies are read aloud using Microsoft Edge TTS (English & Filipino voices)
- 🛡️ **Rate Limiting** — Per-IP request limits to protect all endpoints from abuse

## Quick Start

### 1. Install Dependencies

```bash
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Linux/Mac
pip install -r requirements.txt
```

### 2. Configure Environment

```bash
copy .env.example .env
# Edit .env with your settings
```

Key variables in `.env`:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string |
| `DTS_API_BASE_URL` | DTS backend URL |
| `DTS_MOCK_MODE` | `true` for dev, `false` for production |
| `LLM_SERVICE_URL` | URL of the external LLM service |
| `USE_LLM` | Enable/disable LLM (`True`/`False`) |
| `USE_RAG` | Enable/disable RAG (`True`/`False`) |
| `RAG_DOCUMENT_API_URL` | Admin API URL to fetch documents for RAG indexing |
| `CORS_ORIGINS` | Comma-separated allowed origins |

### 3. Create Database

```sql
mysql -u root -p < schema.sql
```

Or the engine will auto-create tables on first startup.

### 4. Train the Model

```bash
python scripts/train.py
```

Or skip this — the engine auto-trains on startup if no model exists.

### 5. Run the Server

```bash
uvicorn app.main:app --reload
```

Open **http://localhost:8000/docs** for the Swagger UI.

---

## API Endpoints

| Method | Endpoint           | Rate Limit  | Description                                  |
| ------ | ------------------ | ----------- | -------------------------------------------- |
| POST   | `/api/chat`        | 30 / minute | Send a message, get an AI response           |
| POST   | `/api/chat/stream` | 30 / minute | Streaming chat via Server-Sent Events (SSE)  |
| POST   | `/api/train`       | 5 / minute  | Retrain the ML model                         |
| GET    | `/api/health`      | —           | Health check + model status                  |
| POST   | `/api/tts`         | 20 / minute | Convert AI reply text to speech (MP3)        |
| POST   | `/api/rag/ingest`  | —           | Add a document's text to the RAG index       |
| POST   | `/api/rag/delete`  | —           | Remove a document from the RAG index         |

All rate limits are enforced per client IP address.

### Chat Example

```bash
# Ask about document status
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the status of my document?"}'

# Response: {"reply": "What is the Tracking No. of your document?", "session_id": "abc-123", ...}

# Provide PDID (use session_id from previous response)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "PDID 001", "session_id": "abc-123"}'
```

**Topic-based routing** — pass `"topic": "docs"` or `"topic": "lgu"` to lock the AI to a specific mode:

```json
{ "message": "What are the requirements for a business permit?", "topic": "lgu" }
```

### Streaming Chat Example

The `/api/chat/stream` endpoint yields Server-Sent Events. Each event is a JSON object:

```
data: {"session_id": "...", "intent": "lgu_query", "confidence": 0.95, "entities": {}}
data: {"text": "The requirements"}
data: {"text": " for a business permit are..."}
data: [DONE]{"session_id": "...", "intent": "lgu_query", ...}
```

### TTS Example

```bash
curl -X POST http://localhost:8000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Your document is currently being processed.", "voice": "en-US-GuyNeural"}' \
  --output reply.mp3
```

**Available voices:**

| Voice                 | Language        |
| --------------------- | --------------- |
| `en-US-GuyNeural`     | English (male)  |
| `fil-PH-AngeloNeural` | Filipino (male) |

When the default voice (`en-US-GuyNeural`) is used, the endpoint auto-detects Tagalog text and switches to the Filipino voice automatically. Explicitly specifying a voice always respects your choice.

### Retrain the Model

```bash
curl -X POST http://localhost:8000/api/train \
  -H "Content-Type: application/json" \
  -d '{"source": "csv"}'
```

---

## RAG (Retrieval-Augmented Generation)

The RAG system allows the AI to answer questions about local government services, ordinances, and uploaded documents.

- On startup, the engine fetches all documents from the Admin API (`RAG_DOCUMENT_API_URL`) and builds a vector index
- After a document is uploaded/deleted via the Admin Dashboard, it calls `/api/rag/ingest` or `/api/rag/delete` to keep the live index in sync
- Queries in `lgu` mode automatically search the index and pass relevant excerpts to the LLM

The index is cached to `rag_store/rag_cache.pkl` and reloaded on restart.

---

## Adding Training Data

### Option 1: Edit the CSV

Add new rows to `ml_data/intent_training.csv`:

```csv
text,intent
"Where is my leave form?",document_status
"PDID 100",follow_up
```

Then retrain: `POST /api/train {"source": "csv"}`

### Option 2: Insert into Database

```sql
INSERT INTO training_data (text, intent) VALUES
('Where is my leave form?', 'document_status'),
('Check PDID 200 please', 'document_status');
```

Then retrain: `POST /api/train {"source": "database"}`

---

## Switching to Real DTS API

When the DTS team provides their API, update `.env`:

```env
DTS_MOCK_MODE=false
DTS_API_BASE_URL=http://your-dts-server:3001
```

The engine expects `GET {DTS_API_BASE_URL}/api/documents/{pdid}` to return document info as JSON.

---

## Running Tests

```bash
pytest tests/ -v
```

36 tests covering the chat endpoint (multi-turn, PDID tracking, topic routing), entity extraction, and intent classification.

---

## Project Structure

```
DTS_AI/
├── app/
│   ├── main.py              # FastAPI app entry point + lifespan (DB, ML, RAG init)
│   ├── config.py            # Environment settings
│   ├── rate_limiter.py      # Shared slowapi rate limiter instance
│   ├── api/routes.py        # REST endpoints (chat, stream, train, health, tts, rag)
│   ├── ml/                  # ML pipeline
│   │   ├── intent_classifier.py
│   │   ├── entity_extractor.py
│   │   └── preprocessing.py
│   ├── services/            # Business logic
│   │   ├── conversation.py  # Chat orchestrator (process_message, stream_message)
│   │   ├── dts_client.py    # DTS API client (mock + live)
│   │   ├── llm_client.py    # External LLM service client
│   │   ├── rag_service.py   # RAG index (build, retrieve, ingest, delete)
│   │   ├── response_generator.py  # Template-based fallback responses
│   │   └── chat_logger.py   # DB chat logging
│   ├── db/                  # Database
│   │   ├── models.py
│   │   └── database.py
│   └── schemas/chat.py      # Pydantic request/response models
├── ml_data/                 # Training data (intent_training.csv)
├── ml_models/               # Saved trained models
├── rag_store/               # RAG vector index cache
├── scripts/train.py         # Training CLI
├── tests/                   # Test suite (36 tests)
└── schema.sql               # MySQL DDL
```

---

## Production Deployment

For production, apply the following changes before going live.

### 1. Run with Multiple Workers

Replace `--reload` with `--workers` when deploying. `--reload` is for development only.

```bash
uvicorn app.main:app --workers 4 --host 0.0.0.0 --port 8000
```

A good rule of thumb for `--workers` is `2 × CPU cores + 1`. On a 2-core server, use `--workers 5`.

> ⚠️ RAG uses in-memory state. With multiple workers, each process has its own index. Use `/api/rag/ingest` and `/api/rag/delete` after document changes — all workers will pick up the next restart from the shared cache file.

### 2. Scale the Database Connection Pool

In `app/db/database.py`, increase the pool to match your worker count:

```python
engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=5,       # per worker; 4 workers × 5 = 20 total connections
    max_overflow=10,   # burst allowance per worker
    echo=False,
)
```

### 3. Enable DTS Response Caching

If multiple users query the same document, add a short TTL cache to `app/services/dts_client.py`:

```python
from cachetools import TTLCache

_doc_cache = TTLCache(maxsize=200, ttl=300)  # 5-minute cache, 200 documents max

async def get_document(pdid: str):
    pdid_key = pdid.strip().lstrip("0").zfill(3)
    if pdid_key in _doc_cache:
        return _doc_cache[pdid_key]
    # ... existing fetch logic ...
    _doc_cache[pdid_key] = result
    return result
```

### Capacity Reference

| Setup                      | Handles comfortably        |
| -------------------------- | -------------------------- |
| Single worker (`--reload`) | ~20 simultaneous users     |
| 4 workers                  | ~80–100 simultaneous users |
| 4 workers + DTS caching    | 100+ simultaneous users    |

> Hundreds of users **per day** (not simultaneously) is well within the single-worker default.

---

*Built by Clarence Buenaflor, Jester Pastor & Mharjade Enario*

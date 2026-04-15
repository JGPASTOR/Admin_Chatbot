import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.api.routes import router
from app.db.database import engine
from app.db.models import Base
from app.services.conversation import classifier
from app.services import rag_service
from app.services.llm_client import close_stream_client
from app.rate_limiter import limiter


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # --- Startup ---
    print("🚀 Starting DTS AI Engine...")

    # Create database tables if they don't exist
    Base.metadata.create_all(bind=engine)

    # Migrate: add flag_type column if it doesn't exist (safe no-op on re-runs)
    try:
        from sqlalchemy import text as _sql_text
        with engine.connect() as _conn:
            _conn.execute(_sql_text(
                "ALTER TABLE flagged_queries ADD COLUMN flag_type VARCHAR(20) DEFAULT 'low_confidence'"
            ))
            _conn.commit()
        print("✅ Migrated: added flag_type column to flagged_queries")
    except Exception:
        pass  # Column already exists — normal on every subsequent startup

    # Migrate: add Phase-1 observability columns to chat_logs (safe no-op on re-runs)
    try:
        from sqlalchemy import text as _sql_text
        with engine.connect() as _conn:
            _conn.execute(_sql_text(
                "ALTER TABLE chat_logs "
                "ADD COLUMN response_source ENUM('faq_cache','rag_template','llm') DEFAULT NULL AFTER intent, "
                "ADD COLUMN response_ms INT DEFAULT NULL AFTER response_source"
            ))
            _conn.commit()
        print("✅ Migrated: added response_source & response_ms columns to chat_logs")
    except Exception:
        pass  # Columns already exist

    # Migrate: add admin_answer + resolved_at to flagged_queries (safe no-op on re-runs)
    for col_sql in [
        "ALTER TABLE flagged_queries ADD COLUMN admin_answer TEXT DEFAULT NULL",
        "ALTER TABLE flagged_queries ADD COLUMN resolved_at DATETIME DEFAULT NULL",
    ]:
        try:
            from sqlalchemy import text as _sql_text
            with engine.connect() as _conn:
                _conn.execute(_sql_text(col_sql))
                _conn.commit()
        except Exception:
            pass  # Column already exists

    # Migrate: create faq_history table if not yet present (safe no-op on re-runs)
    try:
        from sqlalchemy import text as _sql_text
        with engine.connect() as _conn:
            _conn.execute(_sql_text(
                "CREATE TABLE IF NOT EXISTS faq_history ("
                "  id INT AUTO_INCREMENT PRIMARY KEY,"
                "  faq_id INT NOT NULL,"
                "  change_type VARCHAR(20) NOT NULL,"
                "  changed_by VARCHAR(100) DEFAULT NULL,"
                "  question TEXT DEFAULT NULL,"
                "  answer TEXT DEFAULT NULL,"
                "  section VARCHAR(255) DEFAULT NULL,"
                "  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
                "  FOREIGN KEY (faq_id) REFERENCES faq_entries(id) ON DELETE CASCADE"
                ")"
            ))
            _conn.commit()
        print("✅ Migrated: faq_history table ensured")
    except Exception:
        pass  # Already exists

    print("✅ Database tables ready")

    # Load ML model
    csv_path = os.path.join(settings.TRAINING_DATA_DIR, "intent_training.csv")

    if classifier.load():
        print(f"✅ Intent classifier loaded ({len(classifier.classes)} intents)")
    elif os.path.exists(csv_path):
        # No saved model, but training data exists — auto-train
        print("🔄 No saved model found. Training from CSV...")
        stats = classifier.train(csv_path=csv_path)
        print(f"✅ Trained intent classifier: {stats['num_samples']} samples, "
              f"{stats['num_intents']} intents, {stats['training_accuracy']*100:.1f}% accuracy")
    else:
        print("⚠️  No model or training data found. Train the model via POST /ai/train")

    # Initialize RAG index
    if settings.USE_RAG:
        print("📚 Initializing RAG knowledge base from Admin API...")
        rag_service.initialize_rag(
            api_url=settings.RAG_DOCUMENT_API_URL,
            store_dir=settings.RAG_STORE_DIR,
            locations_api_url=settings.LOCATIONS_API_URL,
        )
        if rag_service.is_ready():
            print("✅ RAG knowledge base ready (Synced from Admin API)")
        else:
            print("⚠️  RAG initialization failed — will answer without document context")

    # Load curated FAQ entries from Admin DB into the in-memory cache
    if settings.FAQ_API_URL:
        try:
            import httpx
            resp = httpx.get(settings.FAQ_API_URL, timeout=8)
            data = resp.json()
            entries = data.get("entries", [])
            if entries:
                rag_service.load_faqs([(e["id"], e["question"], e["answer"]) for e in entries])
                print(f"✅ FAQ cache loaded ({len(entries)} curated entries from Admin DB)")
            else:
                print("ℹ️  No FAQ entries found in Admin DB.")
        except Exception as e:
            print(f"⚠️  Could not load FAQ entries: {e}")

    # Connect Redis cache for RAG query results
    if settings.USE_RAG and settings.RAG_CACHE_ENABLED:
        try:
            await rag_service.connect_redis(settings.REDIS_URL)
            print(f"✅ RAG Redis cache connected ({settings.REDIS_URL})")
        except Exception as e:
            print(f"⚠️  RAG Redis cache unavailable: {e}")

    yield

    # --- Shutdown ---
    print("👋 Shutting down DTS AI Engine...")
    await close_stream_client()
    await rag_service.disconnect_redis()


app = FastAPI(
    title="DTS AI Engine",
    description=(
        "AI-powered Document Tracking Assistant. "
        "Provides a conversational interface for checking document status via the DTS system."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiter
app.state.limiter = limiter


# ── Author watermark middleware ──────────────────────────────────────────
@app.middleware("http")
async def add_watermark_headers(request: Request, call_next):
    """Stamp every HTTP response with author identity headers."""
    response = await call_next(request)
    response.headers["X-Powered-By"] = "DTS AI Engine by Clarence Buenaflor, Jester Pastor & Mharjade Enario v1.0"
    response.headers["X-Author"] = "Clarence Buenaflor, Jester Pastor, Mharjade Enario"
    return response


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please slow down."},
    )


# Include routes
app.include_router(router)


@app.get("/", tags=["Root"])
async def root():
    """Root endpoint — confirms the engine is running."""
    return {
        "name": "DTS AI Engine",
        "version": "1.0.0",
        "built_by": "Clarence Buenaflor, Jester Pastor, Mharjade Enario",
        "description": "AI-powered chatbot for the Document Tracking System",
        "license": "Proprietary — built and owned by Clarence Buenaflor, Jester Pastor & Mharjade Enario",
        "docs": "/docs",
        "health": "/api/health",
    }
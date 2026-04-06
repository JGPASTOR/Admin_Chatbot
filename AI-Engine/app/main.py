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
        )
        if rag_service.is_ready():
            print("✅ RAG knowledge base ready (Synced from Admin API)")
        else:
            print("⚠️  RAG initialization failed — will answer without document context")

    yield

    # --- Shutdown ---
    print("👋 Shutting down DTS AI Engine...")
    await close_stream_client()


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
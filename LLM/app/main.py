"""
LLM Service — Shared LLM Gateway

A lightweight FastAPI microservice that provides a unified /generate
end endpoint for all AI engines. Abstracts Ollama (local)
behind a single API.

Architecture:
    Engine1 :8000 ──┐
                    ├──→ LLM Service :8001 ──→ Ollama :11434 (local)
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.router import router
from app.providers import ollama
from app import cache


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # --- Startup ---
    print("🚀 Starting LLM Service on port", settings.PORT)
    print(f"   Ollama URL:   {settings.OLLAMA_BASE_URL}")
    print(f"   Ollama Model: {settings.OLLAMA_MODEL}")

    # Check Ollama availability
    if await ollama.is_available():
        print("✅ Ollama is reachable")
    else:
        print("⚠️  Ollama is NOT reachable")

    # Connect to Redis
    await cache.connect()

    yield

    # --- Shutdown ---
    await cache.disconnect()
    print("👋 LLM Service shutting down")


app = FastAPI(
    title="LLM Service",
    description=(
        "Shared LLM gateway for the DTS AI system. "
        "Provides a unified /generate endpoint abstraction for Ollama."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow engines to call this service
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router)


@app.get("/", tags=["Root"])
async def root():
    """Root endpoint — confirms the service is running."""
    return {
        "name": "LLM Service",
        "version": "1.0.0",
        "description": "Shared LLM gateway — Local Ollama only",
        "docs": "/docs",
        "health": "/api/providers",
    }

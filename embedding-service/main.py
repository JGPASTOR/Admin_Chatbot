"""
Embedding Microservice — Phase 3 / Task: Extract embedding into dedicated microservice

Instead of each Uvicorn worker loading sentence-transformers (~600 MB RAM each),
all workers call this single lightweight service.

RAM profile:
  Before: 4 workers × 600 MB = 2.4 GB
  After:  1 embedding service × 600 MB + 4 workers × ~50 MB each = ~800 MB total

Endpoints:
  POST /embed        — embed a batch of texts
  GET  /health       — liveness probe
"""

import logging
import os
import time
from typing import List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

# ── Configuration ──────────────────────────────────────────────────────────────
MODEL_NAME: str = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
HOST: str = os.getenv("HOST", "0.0.0.0")
PORT: int = int(os.getenv("PORT", "8002"))
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "info").lower()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("embedding-service")

# ── Model (loaded once at startup) ────────────────────────────────────────────
logger.info(f"Loading SentenceTransformer model: {MODEL_NAME} …")
_load_start = time.time()
model: SentenceTransformer = SentenceTransformer(MODEL_NAME)
logger.info(f"Model loaded in {time.time() - _load_start:.2f}s")

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="DTS Embedding Service",
    description=(
        "Dedicated microservice for sentence-transformer embeddings. "
        "All AI-Engine workers route embedding calls here instead of "
        "loading the model locally — saves 4× RAM at scale."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ── Schemas ────────────────────────────────────────────────────────────────────
class EmbedRequest(BaseModel):
    texts: List[str]          # batch of strings to embed
    normalize: bool = True   # L2-normalize (recommended for cosine similarity)


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]
    model: str
    count: int
    elapsed_ms: float


# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    """
    Encode a batch of texts and return their embeddings.

    - texts: list of strings (up to 512 each for best quality)
    - normalize: L2-normalize vectors (default True — required for cosine similarity)

    Example:
        POST /embed
        {"texts": ["What is the status of my document?"], "normalize": true}
    """
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts list cannot be empty")

    if len(req.texts) > 512:
        raise HTTPException(
            status_code=400,
            detail=f"Batch too large: {len(req.texts)} texts (max 512 per call)",
        )

    t0 = time.perf_counter()
    try:
        vectors = model.encode(
            req.texts,
            normalize_embeddings=req.normalize,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    except Exception as exc:
        logger.error(f"Encoding failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Encoding error: {exc}")

    elapsed = (time.perf_counter() - t0) * 1000

    return EmbedResponse(
        embeddings=vectors.tolist(),
        model=MODEL_NAME,
        count=len(req.texts),
        elapsed_ms=round(elapsed, 2),
    )


@app.get("/health")
async def health():
    """Liveness probe — returns OK if the model is loaded."""
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "embedding_dim": model.get_sentence_embedding_dimension(),
    }


@app.get("/")
async def root():
    return {
        "name": "DTS Embedding Service",
        "version": "1.0.0",
        "model": MODEL_NAME,
        "built_by": "Clarence Buenaflor, Jester Pastor, Mharjade Enario",
        "docs": "/docs",
        "health": "/health",
    }


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("main:app", host=HOST, port=PORT, log_level=LOG_LEVEL)

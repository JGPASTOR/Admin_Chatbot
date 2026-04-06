"""
API router for the LLM Service.

Exposes a single /generate endpoint that tries Ollama first,
then falls back to Gemini if Ollama is unavailable.
"""

import json
import time
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.providers import ollama
from app import cache

router = APIRouter(prefix="/api", tags=["LLM"])


# ── Request / Response schemas ───────────────────────────────────────────────

class GenerateRequest(BaseModel):
    """Request body for /generate."""
    prompt: str = Field(..., min_length=1, description="The user prompt to send to the LLM.")
    system_prompt: Optional[str] = Field(
        None,
        description="Optional system-level instruction (persona, rules, etc.).",
    )
    model: Optional[str] = Field(
        None,
        description="Override the default model for the chosen provider.",
    )


class GenerateResponse(BaseModel):
    """Response body from /generate."""
    response: str
    provider_used: str
    model_used: str
    elapsed_ms: int


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest):
    """
    Generate a response from the local LLM.

    Strategy:
    0. Check Redis cache for an identical previous request.
    1. Call local Ollama.

    Returns the generated text along with metadata about which
    model was used.
    """
    # ── Cache lookup ─────────────────────────────────────────────────
    cached = await cache.get_cached(
        prompt=request.prompt,
        system_prompt=request.system_prompt,
        model=request.model,
    )
    if cached:
        return GenerateResponse(
            response=cached["response"],
            provider_used=cached["provider_used"] + " (cached)",
            model_used=cached["model_used"],
            elapsed_ms=0,
        )

    # ── LLM generation ───────────────────────────────────────────────
    start = time.time()

    try:
        result = await _try_ollama(request, start)
    except Exception as ollama_err:
        print(f"⚠️  Ollama failed: {ollama_err}")
        raise HTTPException(
            status_code=503,
            detail=f"Local LLM is unavailable: {ollama_err}"
        )

    # ── Store in cache ───────────────────────────────────────────────
    await cache.set_cached(
        prompt=request.prompt,
        system_prompt=request.system_prompt,
        model=request.model,
        response_data={
            "response": result.response,
            "provider_used": result.provider_used,
            "model_used": result.model_used,
        },
    )

    return result


@router.post("/generate-stream")
async def generate_stream(request: GenerateRequest):
    """
    Stream a response from an LLM via Server-Sent Events (SSE).
    """
        
    async def sse_generator():
        try:
            async for token in ollama.generate_stream(
                prompt=request.prompt,
                system_prompt=request.system_prompt,
                model=request.model,
            ):
                # Send Server-Sent Events format
                yield f"data: {json.dumps({'token': token})}\n\n"
                
            yield f"data: {json.dumps({'done': True})}\n\n"
            
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    # Important headers for unbuffered SSE streaming
    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no" # Tells Nginx to disable buffering
        }
    )


# ── Provider helpers ─────────────────────────────────────────────────────────

async def _try_ollama(request: GenerateRequest, start: float) -> GenerateResponse:
    """Attempt generation via Ollama."""
    from app.config import settings

    try:
        text = await ollama.generate(
            prompt=request.prompt,
            system_prompt=request.system_prompt,
            model=request.model,
        )
        return GenerateResponse(
            response=text,
            provider_used="ollama",
            model_used=request.model or settings.OLLAMA_MODEL,
            elapsed_ms=int((time.time() - start) * 1000),
        )
    except Exception as e:
        raise Exception(f"Ollama error: {e}")


# ── Health / status ──────────────────────────────────────────────────────────

class ProviderStatus(BaseModel):
    ollama_available: bool


@router.get("/providers", response_model=ProviderStatus)
async def provider_status():
    """Check if local LLM is available."""
    return ProviderStatus(
        ollama_available=await ollama.is_available(),
    )


# ── Cache management ─────────────────────────────────────────────────────────

@router.get("/cache/stats")
async def cache_stats():
    """Return cache hit/miss statistics and entry count."""
    return await cache.get_stats()


@router.delete("/cache/clear")
async def cache_clear():
    """Flush all cached LLM responses and reset counters."""
    deleted = await cache.clear_cache()
    return {"deleted": deleted, "message": f"Cleared {deleted} cached entries"}

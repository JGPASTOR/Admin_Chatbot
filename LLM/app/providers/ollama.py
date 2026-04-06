"""
Ollama LLM provider — calls the local Ollama server.

Endpoint: POST {OLLAMA_BASE_URL}/api/generate
Docs:     https://github.com/ollama/ollama/blob/main/docs/api.md
"""

import httpx
from typing import Optional

from app.config import settings


async def generate(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
) -> str:
    """
    Send a prompt to Ollama and return the generated text.

    Args:
        prompt:        The user/input prompt.
        system_prompt: Optional system-level instruction.
        model:         Override the default model from settings.

    Returns:
        The generated text response.

    Raises:
        httpx.HTTPError:     On connection / HTTP errors.
        Exception:           On unexpected response format.
    """
    model = model or settings.OLLAMA_MODEL

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,        # get the full response in one shot
    }

    if system_prompt:
        payload["system"] = system_prompt

    async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT) as client:
        response = await client.post(
            f"{settings.OLLAMA_BASE_URL}/api/generate",
            json=payload,
        )
        response.raise_for_status()

    data = response.json()
    text = data.get("response", "")

    if not text:
        raise Exception("Ollama returned an empty response")

    return text.strip()


async def generate_stream(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
):
    """
    Send a prompt to Ollama and yield the generated text as it streams.
    Returns AsyncGenerator[str, None].
    """
    model = model or settings.OLLAMA_MODEL

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,  # stream tokens as they arrive
    }

    if system_prompt:
        payload["system"] = system_prompt

    async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT) as client:
        async with client.stream("POST", f"{settings.OLLAMA_BASE_URL}/api/generate", json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line:
                    continue
                import json
                try:
                    chunk = json.loads(line)
                    token = chunk.get("response", "")
                    if token:
                        yield token
                    if chunk.get("done"):
                        break
                except json.JSONDecodeError:
                    continue


async def is_available() -> bool:
    """Check if Ollama is reachable and ready."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{settings.OLLAMA_BASE_URL}/api/tags")
            return resp.status_code == 200
    except Exception:
        return False

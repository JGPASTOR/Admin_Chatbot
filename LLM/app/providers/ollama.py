"""
Ollama LLM provider — calls the local Ollama server.

Endpoint: POST {OLLAMA_BASE_URL}/api/generate
Docs:     https://github.com/ollama/ollama/blob/main/docs/api.md

Note: Qwen3 models may emit <think>...</think> reasoning blocks before the
actual answer. These are stripped automatically so callers always receive
clean, user-facing text.
"""

import re
import httpx
from typing import Optional

from app.config import settings


def _strip_think_tags(text: str) -> str:
    """
    Remove Qwen3 chain-of-thought <think>...</think> blocks from a response.
    The blocks can be multi-line and appear anywhere in the text.
    """
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    return text.strip()


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
        The generated text response (think tags stripped).

    Raises:
        httpx.HTTPError:     On connection / HTTP errors.
        Exception:           On unexpected response format.
    """
    model = model or settings.OLLAMA_MODEL

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,        # get the full response in one shot
        "options": {
            "think": False,     # disable Qwen3 thinking mode for faster responses
        },
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

    return _strip_think_tags(text)


async def generate_stream(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
):
    """
    Send a prompt to Ollama and yield the generated text as it streams.
    Returns AsyncGenerator[str, None].
    Think tags are buffered and stripped before being yielded.
    """
    model = model or settings.OLLAMA_MODEL

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,         # stream tokens as they arrive
        "options": {
            "think": False,     # disable Qwen3 thinking mode
        },
    }

    if system_prompt:
        payload["system"] = system_prompt

    buffer = ""  # accumulate tokens to catch cross-chunk <think> blocks
    in_think = False

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
                        buffer += token
                        # Toggle think-block suppression
                        if "<think>" in buffer.lower():
                            in_think = True
                        if in_think and "</think>" in buffer.lower():
                            in_think = False
                            # Flush everything after the closing tag
                            after = re.split(r"</think>", buffer, maxsplit=1, flags=re.IGNORECASE)[-1]
                            buffer = after
                            if buffer.strip():
                                yield buffer
                                buffer = ""
                        elif not in_think and not buffer.lower().startswith("<think"):
                            yield buffer
                            buffer = ""
                    if chunk.get("done"):
                        # Flush any remaining buffered text
                        if buffer.strip() and not in_think:
                            yield _strip_think_tags(buffer)
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

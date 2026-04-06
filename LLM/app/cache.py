"""
Redis cache layer for the LLM Service.

Caches LLM responses keyed by a SHA-256 hash of (prompt + system_prompt + model).
Identical requests return instantly from cache instead of hitting the LLM.
"""

import hashlib
import json
from typing import Optional

import redis.asyncio as redis

from app.config import settings

# Module-level connection pool
_redis: Optional[redis.Redis] = None

# In-memory counters (reset on restart)
_hits = 0
_misses = 0


def _make_key(prompt: str, system_prompt: Optional[str], model: Optional[str]) -> str:
    """Create a deterministic cache key from the request parameters."""
    raw = json.dumps(
        {
            "prompt": prompt,
            "system_prompt": system_prompt or "",
            "model": model or settings.OLLAMA_MODEL,
        },
        sort_keys=True,
    )
    digest = hashlib.sha256(raw.encode()).hexdigest()
    return f"llm:cache:{digest}"


async def connect():
    """Open the async Redis connection pool."""
    global _redis
    try:
        _redis = redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
        )
        # Verify connectivity
        await _redis.ping()
        print(f"✅ Redis connected at {settings.REDIS_URL}")
    except Exception as e:
        print(f"⚠️  Redis connection failed: {e} — caching disabled")
        _redis = None


async def disconnect():
    """Close the Redis connection pool."""
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None
        print("👋 Redis disconnected")


async def get_cached(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
) -> Optional[dict]:
    """
    Look up a cached response.

    Returns the cached response dict if found, or None on a miss.
    """
    global _hits, _misses

    if not settings.CACHE_ENABLED or _redis is None:
        _misses += 1
        return None

    key = _make_key(prompt, system_prompt, model)

    try:
        raw = await _redis.get(key)
        if raw:
            _hits += 1
            return json.loads(raw)
    except Exception as e:
        print(f"⚠️  Redis GET error: {e}")

    _misses += 1
    return None


async def set_cached(
    prompt: str,
    system_prompt: Optional[str],
    model: Optional[str],
    response_data: dict,
):
    """
    Store a response in the cache with the configured TTL.
    """
    if not settings.CACHE_ENABLED or _redis is None:
        return

    key = _make_key(prompt, system_prompt, model)

    try:
        await _redis.set(key, json.dumps(response_data), ex=settings.CACHE_TTL)
    except Exception as e:
        print(f"⚠️  Redis SET error: {e}")


async def get_stats() -> dict:
    """Return cache statistics."""
    total = _hits + _misses
    cached_keys = 0

    if _redis:
        try:
            # Count only our llm:cache:* keys
            cursor, keys = await _redis.scan(match="llm:cache:*", count=1000)
            cached_keys = len(keys)
            while cursor != 0:
                cursor, batch = await _redis.scan(
                    cursor=cursor, match="llm:cache:*", count=1000
                )
                cached_keys += len(batch)
        except Exception:
            pass

    return {
        "cache_enabled": settings.CACHE_ENABLED and _redis is not None,
        "hits": _hits,
        "misses": _misses,
        "hit_rate": round(_hits / total * 100, 1) if total > 0 else 0.0,
        "total_requests": total,
        "cached_entries": cached_keys,
        "ttl_seconds": settings.CACHE_TTL,
    }


async def clear_cache() -> int:
    """
    Delete all llm:cache:* keys from Redis.
    Returns the number of keys deleted.
    """
    global _hits, _misses

    if _redis is None:
        return 0

    deleted = 0
    try:
        cursor, keys = await _redis.scan(match="llm:cache:*", count=1000)
        while True:
            if keys:
                deleted += await _redis.delete(*keys)
            if cursor == 0:
                break
            cursor, keys = await _redis.scan(
                cursor=cursor, match="llm:cache:*", count=1000
            )
    except Exception as e:
        print(f"⚠️  Redis CLEAR error: {e}")

    # Reset counters
    _hits = 0
    _misses = 0

    return deleted

"""Client for the central LLM Service."""

import re
import httpx
import logging
from typing import Dict, Any, Optional

from app.config import settings
from app.services.response_generator import _format_document_status

logger = logging.getLogger(__name__)

# Shared client for streaming requests (reused to avoid connection leaks)
_stream_client: Optional[httpx.AsyncClient] = None


def _get_stream_client() -> httpx.AsyncClient:
    """Get or create the shared streaming client."""
    global _stream_client
    if _stream_client is None:
        _stream_client = httpx.AsyncClient(timeout=35.0)
    return _stream_client


async def close_stream_client() -> None:
    """Close the shared streaming client. Call on app shutdown."""
    global _stream_client
    if _stream_client is not None:
        await _stream_client.aclose()
        _stream_client = None


async def generate_llm_response(
    intent: str,
    entities: Dict[str, str],
    document: Optional[Dict[str, Any]] = None,
    context: dict = None,
    rag_context: Optional[str] = None,
    user_message: str = "",
    language: str = "en",
) -> Optional[str]:
    """
    Call the external LLM Service to generate a conversational response.
    Returns None if the LLM generation fails, allowing fallback to templates.
    """
    # Build prompt based on intent
    prompt = _build_prompt(intent, entities, document, context, rag_context, user_message)
    if not prompt:
        return None  # Will fall back to template rules (e.g., asking for PDID)

    lang_instruction = " Respond in Filipino (Tagalog)." if language == "tl" else ""
    system_prompt = (
        "You are the DTS AI Assistant built by Clarence Buenaflor, Jester Pastor & Mharjade Enario. "
        "You help users track their documents in the Document Tracking System. "
        "Be friendly, helpful, and concise."
        f"{lang_instruction} "
        "If document data is provided, use it to accurately answer the user's question. "
        "Do NOT hallucinate document statuses — only use the data provided."
    )

    try:
        async with httpx.AsyncClient(timeout=35.0) as client:
            response = await client.post(
                f"{settings.LLM_SERVICE_URL}/api/generate",
                json={
                    "prompt": prompt,
                    "system_prompt": system_prompt
                }
            )
            response.raise_for_status()
            data = response.json()
            return data.get("response")
    except Exception as e:
        logger.error(f"Error calling LLM Service: {e}")
        return None


async def generate_llm_response_stream(
    intent: str,
    entities: Dict[str, str],
    document: Optional[Dict[str, Any]] = None,
    context: dict = None,
    rag_context: Optional[str] = None,
    user_message: str = "",
    language: str = "en",
) -> Optional[httpx.Response]:
    """
    Call the external LLM Service to generate a conversational response and stream it.
    This expects the LLM Service's /api/generate endpoint to support streaming with `stream: True`.
    If the LLM Service doesn't support streaming, it will just yield the whole response at once.
    """
    # Build prompt based on intent
    prompt = _build_prompt(intent, entities, document, context, rag_context, user_message)
    if not prompt:
        return None  # Will fall back to template rules (e.g., asking for PDID)

    lang_instruction = " Respond in Filipino (Tagalog)." if language == "tl" else ""

    # Build context-aware system prompt — if we have RAG data, shift to knowledge assistant mode
    if rag_context:
        system_prompt = (
            "You are the DTS AI Assistant, a helpful assistant for the local government built by "
            "Clarence Buenaflor, Jester Pastor & Mharjade Enario."
            f"{lang_instruction} "
            "When document excerpts are provided in the user prompt, your ONLY job is to answer "
            "the user's question using EXCLUSIVELY that data. "
            "Do NOT say you cannot help. Do NOT ask for a Tracking Number. "
            "Do NOT make up information not found in the excerpts. "
            "Respond concisely with what you find."
        )
    else:
        system_prompt = (
            "You are the DTS AI Assistant built by Clarence Buenaflor, Jester Pastor & Mharjade Enario. "
            "You help users track their documents in the Document Tracking System. "
            "Be friendly, helpful, and concise."
            f"{lang_instruction} "
            "If document data is provided, use it to accurately answer the user's question. "
            "Do NOT hallucinate document statuses — only use the data provided."
        )

    try:
        client = _get_stream_client()
        request = client.build_request(
            "POST",
            f"{settings.LLM_SERVICE_URL}/api/generate-stream",
            json={
                "prompt": prompt,
                "system_prompt": system_prompt,
            }
        )
        return await client.send(request, stream=True)
    except Exception as e:
        logger.error(f"Error calling LLM Service Stream: {e}")
        return None


def _build_prompt(
    intent: str,
    entities: Dict[str, str],
    document: Optional[Dict[str, Any]],
    context: dict,
    rag_context: Optional[str] = None,
    user_message: str = "",
) -> Optional[str]:
    """Build the prompt string sent to the LLM."""
    
    # HARD OVERRIDE: If we successfully fetched a document from a valid PDID,
    # NEVER ask the LLM to format it or ramble about it. ALWAYS bypass to the 
    # structured template renderer which builds the nice UI card.
    if document:
        return None

    if intent in ("document_status", "follow_up") and "pdid" in entities:
        # Return None so conversation.py falls back to the clean "not found" template
        # or the structured document card via response_generator.
        return None

    if intent == "document_status" and "pdid" not in entities and not rag_context:
        # No PDID and no RAG context — let it fall through to ask for PDID via template.
        # But if there IS rag_context, let it fall through to the RAG prompts below.
        return None

    if intent == "help":
        return (
            "The user is asking for help or what you can do. Briefly explain that you "
            "can help them track documents if they provide a Tracking Number (PDID)."
        )

    if intent == "complaint":
        return (
            "The user is expressing a complaint or frustration. Be empathetic, apologize "
            "for any inconvenience, and suggest they visit the DTS office or provide their "
            "Tracking No. so you can check on it."
        )

    # Handle follow_up that has no PDID — if RAG context found, treat it as a knowledge search.
    # This handles "HOW ABOUT [name]?" style queries mid-conversation.
    if intent == "follow_up" and "pdid" not in entities and rag_context:
        return (
            f"The user is continuing a conversation and asked: \"{user_message or 'a question'}\"\n\n"
            f"Search the document excerpts below and find relevant information. "
            f"Do NOT ask for a Tracking Number. Simply answer what you find.\n\n"
            f"--- Document Excerpts ---\n{rag_context}\n--- End of Excerpts ---\n\n"
            f"Answer concisely from the excerpts above."
        )

    # RAG-powered general query or generic LGU question
    if intent in ("lgu_query", "follow_up") or rag_context:
        question = user_message or "a question"
        if rag_context:
            # If the user asked about a specific section, add a focused instruction
            section_match = re.search(r'\bsection\s+(\d+)\b', question, re.IGNORECASE)
            section_hint = (
                f" The user is specifically asking about Section {section_match.group(1)}. "
                f"Focus your answer on that section's content."
            ) if section_match else ""

            return (
                f"The user asked: \"{question}\"\n\n"
                f"Use ONLY the following excerpts from our official knowledge base and uploaded documents to answer."
                f"{section_hint} "
                f"Do NOT make up information not found below. If the answer isn't in the excerpts, "
                f"say so politely and suggest they contact the DTS office.\n\n"
                f"--- Document Excerpts ---\n{rag_context}\n--- End of Excerpts ---\n\n"
                f"Provide a clear, concise, and helpful answer based on the above."
            )
        else:
            return (
                f"The user is asking a general question about local government services or tracking: \"{question}\"\n\n"
                f"Please provide a helpful, polite, and brief general response based on your knowledge."
            )

    return None

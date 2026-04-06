"""
Conversation engine — orchestrates the full chat pipeline.

Handles:
1. Session management (create/resume multi-turn sessions)
2. Intent classification
3. Entity extraction
4. DTS API lookup
5. Response generation (LLM or template fallback)
6. Chat logging
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from sqlalchemy.orm import Session as DBSession

from app.db.models import Session, ChatLog
from app.ml.intent_classifier import IntentClassifier
from app.ml.entity_extractor import extract_entities
from app.services.dts_client import get_document
from app.services.response_generator import generate_response
from app.services.chat_logger import log_message
from app.services.llm_client import generate_llm_response
from app.services import rag_service
from app.config import settings


# Global classifier instance (loaded at startup)
classifier = IntentClassifier()


def get_or_create_session(db: DBSession, session_id: Optional[str] = None) -> Session:
    """Get an existing session or create a new one."""
    if session_id:
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            session.last_active = datetime.now(timezone.utc)
            db.commit()
            return session

    # Create new session
    new_session = Session(
        id=str(uuid.uuid4()),
        context={},
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return new_session


def update_session_context(db: DBSession, session: Session, key: str, value: Any):
    """Update a key in the session context JSON."""
    ctx = dict(session.context) if session.context else {}
    ctx[key] = value
    session.context = ctx
    db.commit()


@dataclass
class PipelineResult:
    """Result of the shared chat pipeline logic."""
    session: Any
    intent: str
    confidence: float
    entities: Dict[str, str]
    context: dict
    document: Optional[Dict[str, Any]]
    rag_context: Optional[str]


async def _run_pipeline(
    db: DBSession,
    message: str,
    session_id: Optional[str] = None,
    topic: Optional[str] = None,
) -> PipelineResult:
    """
    Shared pipeline logic used by both process_message and stream_message.

    Handles:
    1. Session creation/retrieval
    2. Intent classification + topic enforcement
    3. Entity extraction + multi-turn context (pending PDID)
    4. DTS document fetch
    5. RAG retrieval + state management

    Returns a PipelineResult with all computed values.
    """
    # 1. Session
    session = get_or_create_session(db, session_id)

    # 2. Classify intent
    intent, confidence = classifier.predict(message)

    # 3. Extract entities
    entities = extract_entities(message)

    # ── Strict topic enforcement — override intent to match selected mode ──
    # docs mode: only allow document tracking intents
    # lgu mode: only allow knowledge/RAG intents, never ask for PDID
    if topic == "docs":
        if intent in ("lgu_query", "tourism_query", "unknown"):
            intent = "document_status"
    elif topic == "lgu":
        if intent in ("document_status", "follow_up") and "pdid" not in entities:
            intent = "lgu_query"

    # 4. Multi-turn context: check if we're waiting for a PDID
    context = dict(session.context) if session.context else {}
    pending_intent = context.get("pending_intent")

    # If the user provides a PDID (or just a number) and we were waiting for one
    if "pdid" in entities and pending_intent == "document_status":
        intent = "follow_up"
        update_session_context(db, session, "pending_intent", None)

    # Also check if there's a PDID in context from a previous message
    if "pdid" not in entities and context.get("last_pdid"):
        if intent in ("document_status", "follow_up"):
            entities["pdid"] = context["last_pdid"]

    # Save PDID to context for future reference
    if "pdid" in entities:
        update_session_context(db, session, "last_pdid", entities["pdid"])

    # 5. Fetch document from DTS if we have a PDID
    document = None
    if "pdid" in entities:
        document = await get_document(entities["pdid"])

    # 5b. RAG retrieval — fetch relevant document context
    rag_context = None
    if settings.USE_RAG and rag_service.is_ready() and topic != "docs":
        if not document and intent in ("lgu_query", "tourism_query", "unknown", "document_status", "follow_up", "help", "complaint"):
            rag_context = rag_service.retrieve_context(
                query=message,
                top_k=settings.RAG_TOP_K,
            )

    # If RAG found results, clear pending tracking state so follow-up messages
    # (like "HOW ABOUT [name]?") also search RAG instead of being treated as PDID replies.
    if rag_context:
        update_session_context(db, session, "pending_intent", None)
        # Reclassify follow_up to lgu_query when RAG found results.
        # Do NOT reclassify document_status — explicit tracking requests must ask for PDID.
        if intent == "follow_up" and "pdid" not in entities and not document:
            intent = "lgu_query"
    elif intent == "document_status" and "pdid" not in entities and not document:
        update_session_context(db, session, "pending_intent", "document_status")

    return PipelineResult(
        session=session,
        intent=intent,
        confidence=confidence,
        entities=entities,
        context=context,
        document=document,
        rag_context=rag_context,
    )


async def process_message(
    db: DBSession,
    message: str,
    session_id: Optional[str] = None,
    language: str = "en",
    topic: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Process a user message through the full AI pipeline.

    Pipeline:
    1. Run shared pipeline (classify, extract, fetch, RAG)
    2. Generate response (LLM if enabled, template as fallback)
    3. Log messages

    Args:
        db: Database session
        message: Raw user message
        session_id: Optional session ID for multi-turn context
        language: Language hint (kept for API compatibility)
        topic: User-selected topic ('docs' or 'lgu'). Enforces strict intent routing.

    Returns:
        Dict with reply, session_id, intent, confidence, entities
    """
    p = await _run_pipeline(db, message, session_id, topic)

    # ── Hard guard: PDID provided but not found in DTS → skip LLM entirely ──
    if "pdid" in p.entities and not p.document:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", reply)
        return {
            "reply": reply,
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
        }

    # Generate response — try LLM first, fall back to templates
    reply = None
    if settings.USE_LLM:
        try:
            reply = await generate_llm_response(
                p.intent, p.entities, p.document, p.context,
                rag_context=p.rag_context, user_message=message,
                language=language,
            )
        except Exception as e:
            print(f"LLM generation failed, falling back to template: {e}")

    if not reply:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)

    # Log messages
    log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
    log_message(db, p.session.id, "bot", reply)

    return {
        "reply": reply,
        "session_id": p.session.id,
        "intent": p.intent,
        "confidence": round(p.confidence, 4),
        "entities": p.entities,
    }


async def stream_message(
    db: DBSession,
    message: str,
    session_id: Optional[str] = None,
    language: str = "en",
    topic: Optional[str] = None,
):
    """
    Process a user message and yield Server-Sent Events (SSE).
    """
    p = await _run_pipeline(db, message, session_id, topic)

    # First yield the metadata (intent, entities, session_id)
    metadata = {
        "session_id": p.session.id,
        "intent": p.intent,
        "confidence": round(p.confidence, 4),
        "entities": p.entities,
    }
    yield f"data: {json.dumps(metadata)}\n\n"

    # ── Hard guard: PDID provided but not found in DTS → skip LLM entirely ──
    if "pdid" in p.entities and not p.document:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", reply)
        yield f"data: {json.dumps({'text': reply})}\n\n"
        done_meta = json.dumps({
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
            "language": language,
        })
        yield f"data: [DONE]{done_meta}\n\n"
        return

    full_reply = ""
    
    # Check if we can stream from LLM
    if settings.USE_LLM:
        from app.services.llm_client import generate_llm_response_stream
        
        response_stream = await generate_llm_response_stream(
            p.intent, p.entities, p.document, p.context,
            rag_context=p.rag_context, user_message=message,
            language=language,
        )
        
        if response_stream:
            try:
                async for line in response_stream.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data: "):
                        continue
                    
                    try:
                        json_str = line[6:]
                        chunk_data = json.loads(json_str)
                        
                        if "error" in chunk_data:
                            print(f"LLM Stream Error: {chunk_data['error']}")
                            break
                            
                        if chunk_data.get("done"):
                            break
                            
                        text_chunk = chunk_data.get("token", "")
                        if text_chunk:
                            full_reply += text_chunk
                            yield f"data: {json.dumps({'text': text_chunk})}\n\n"
                    except json.JSONDecodeError:
                        continue
            except Exception as e:
                print(f"Error streaming LLM response: {e}")
            finally:
                await response_stream.aclose()
                
    # If no LLM streaming occurred/succeeded, fallback to template
    if not full_reply:
        full_reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)
        done_meta = json.dumps({
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
            "language": language,
        })
        yield f"data: {json.dumps({'text': full_reply})}\n\ndata: [DONE]{done_meta}\n\n"
    else:
        done_meta = json.dumps({
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
            "language": language,
        })
        yield f"data: [DONE]{done_meta}\n\n"
    
    # Log the complete interaction
    log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
    log_message(db, p.session.id, "bot", full_reply)

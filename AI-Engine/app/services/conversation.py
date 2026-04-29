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

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from sqlalchemy.orm import Session as DBSession

from app.db.models import Session, ChatLog, FlaggedQuery
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


def flag_unknown_query(
    db: DBSession,
    question: str,
    session_id: str,
    confidence: float,
    topic: Optional[str],
    flag_type: str = "low_confidence",
):
    """Save a problematic query to the flagged_queries table for admin review.

    flag_type values:
      low_confidence  — classifier unsure (intent=unknown, conf ≥ 0.3)
      wrong_prompt    — very low confidence, likely off-topic/gibberish (conf < 0.3)
      missing_info    — valid intent but the knowledge base has no answer (RAG gap)
    """
    try:
        # Avoid duplicate pending flags for the same question
        existing = db.query(FlaggedQuery).filter(
            FlaggedQuery.question == question,
            FlaggedQuery.status == "pending",
        ).first()
        if existing:
            return

        entry = FlaggedQuery(
            question=question,
            session_id=session_id,
            confidence=confidence,
            topic=topic,
            flag_type=flag_type,
            status="pending",
        )
        db.add(entry)
        db.commit()
    except Exception as e:
        print(f"[FlaggedQuery] Failed to log query: {e}")
        db.rollback()


def update_session_context(db: DBSession, session: Session, key: str, value: Any):
    """Update a key in the session context JSON."""
    ctx = dict(session.context) if session.context else {}
    ctx[key] = value
    session.context = ctx
    db.commit()


async def _auto_cache_faq(question: str, answer: str) -> None:
    """
    Fire-and-forget: persist a successful LLM+RAG answer to the FAQ database so
    identical or very similar future questions are served instantly (faq_cache path)
    without calling Ollama again.

    Only triggered when:
      - The LLM was used (not a template)
      - The answer was RAG-grounded (rag_context existed — not hallucinated)
      - The answer is substantial (> 50 chars)
      - No sufficiently similar FAQ already exists (dedup threshold 0.80)

    Uses its own DB session so the caller's request-scoped session can close normally.
    Generates 4 question variants via LLM in a thread executor so short/varied user
    queries (e.g. "ano ang bayad?") also hit the cached FAQ next time.
    """
    from app.db.database import SessionLocal
    from app.db.models import FAQEntry, FAQHistory

    db = SessionLocal()
    try:
        # Dedup: skip if a very similar answer is already in the FAQ DB
        if rag_service.is_faq_duplicate(question, threshold=0.80):
            return

        # Persist to MySQL
        entry = FAQEntry(question=question, answer=answer, section=None)
        db.add(entry)
        db.flush()  # get id before commit
        db.add(FAQHistory(
            faq_id=entry.id,
            question=question,
            answer=answer,
            changed_by="ai-cached",
            change_type="created",
        ))
        db.commit()
        db.refresh(entry)

        # Hot-load the main question into ChromaDB immediately
        rag_service.add_faq_to_cache(entry.id, entry.question, entry.answer)

        # Generate question variants in a thread executor (LLM call is sync)
        llm_url = settings.LLM_SERVICE_URL
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            rag_service.store_faq_variants_sync,
            entry.id, question, answer, llm_url, 4,
        )

        print(f"[AutoCache] FAQ id={entry.id} cached: '{question[:70]}'")

    except Exception as e:
        print(f"[AutoCache] Failed to cache FAQ: {e}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


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
    faq_answer: Optional[str] = field(default=None)  # curated answer — returned directly if set


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

    # 5a. OpenStreetMap Places lookup — answers location queries for free
    #     (e.g., "where is KFC?", "restaurants near surigao", "nearest hospital")
    #     This runs BEFORE RAG so location queries get instant, live answers.
    faq_answer = None
    rag_context = None
    if topic != "docs" and not document and "pdid" not in entities:
        try:
            from app.services.places_service import is_places_query, search_places, format_place_response
            if is_places_query(message):
                places = await search_places(message, max_results=3)
                if places:
                    faq_answer = format_place_response(places, message)
        except Exception as _places_err:
            logger.debug(f"[Places] OSM lookup error (non-fatal): {_places_err}")

    # 5b. Parallel FAQ + RAG retrieval (only if Places didn't already answer)
    if not faq_answer and settings.USE_RAG and rag_service.is_ready() and topic != "docs" and not document:
        faq_answer, rag_context = await rag_service.retrieve_parallel(
            message, top_k=settings.RAG_TOP_K
        )
        # If FAQ already matched, we don't need the RAG context
        if faq_answer:
            rag_context = None

    # Keyword fallback: semantic FAQ failed + RAG found nothing
    # Search faq_entries in MySQL by keywords so short queries like
    # "what is national priority 8?" still find answers from long stored questions.
    if not faq_answer and not rag_context and topic != "docs":
        from app.db.models import FAQEntry
        import re as _re
        _stop = {"what","is","the","a","an","of","in","for","and","or","are","how","why","who","when","where"}
        _words = [w for w in _re.findall(r'\b[a-zA-Z0-9]+\b', message.lower()) if w not in _stop and len(w) >= 2]
        if _words:
            # Build a LIKE filter requiring ALL keywords to be present
            from sqlalchemy import and_
            conditions = [FAQEntry.question.ilike(f"%{w}%") for w in _words]
            kw_match = db.query(FAQEntry).filter(and_(*conditions)).first()
            if not kw_match and len(_words) > 2:
                # Relax: require any 2-word combination (for partial matches)
                from sqlalchemy import or_
                pairs = []
                for i in range(len(_words) - 1):
                    pairs.append(and_(FAQEntry.question.ilike(f"%{_words[i]}%"),
                                      FAQEntry.question.ilike(f"%{_words[i+1]}%")))
                if pairs:
                    kw_match = db.query(FAQEntry).filter(or_(*pairs)).first()
            if kw_match:
                faq_answer = kw_match.answer

    # If RAG found results, clear pending tracking state so follow-up messages
    # (like "HOW ABOUT [name]?") also search RAG instead of being treated as PDID replies.
    if rag_context:
        update_session_context(db, session, "pending_intent", None)
        # Reclassify follow_up/help/unknown to lgu_query or tourism_query when RAG found
        # results in LGU mode.  Do NOT reclassify document_status — explicit tracking
        # requests must ask for PDID.
        if intent in ("follow_up", "help", "unknown") and "pdid" not in entities and not document and topic == "lgu":
            # If the original message looks tourism-related, keep it as tourism_query
            _tourism_kw = {"tourist", "tourism", "spot", "beach", "island", "festival", "visit", "attraction", "resort", "travel"}
            if any(kw in message.lower() for kw in _tourism_kw):
                intent = "tourism_query"
            else:
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
        faq_answer=faq_answer,
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
    t0 = time.monotonic()
    p = await _run_pipeline(db, message, session_id, topic)

    # ── FAQ short-circuit: curated answer available → return it directly ──
    if p.faq_answer:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", p.faq_answer,
                    response_source="faq_cache", response_ms=elapsed_ms)
        return {
            "reply": p.faq_answer,
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
        }

    # ── Hard guard: PDID provided but not found in DTS → skip LLM entirely ──
    if "pdid" in p.entities and not p.document:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", reply,
                    response_source="rag_template", response_ms=elapsed_ms)
        return {
            "reply": reply,
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
        }

    # Generate response — try LLM first, fall back to templates
    reply = None
    used_llm = False
    if settings.USE_LLM:
        try:
            reply = await generate_llm_response(
                p.intent, p.entities, p.document, p.context,
                rag_context=p.rag_context, user_message=message,
                language=language,
            )
            if reply:
                used_llm = True
        except Exception as e:
            print(f"LLM generation failed, falling back to template: {e}")

    if not reply:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    src = "llm" if used_llm else "rag_template"

    # Log messages
    log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
    log_message(db, p.session.id, "bot", reply,
                response_source=src, response_ms=elapsed_ms)

    # Auto-cache: persist successful RAG-grounded LLM answers to FAQ DB so
    # future similar questions are served instantly (no Ollama call needed).
    # Only for general-services questions (lgu_query / follow_up with RAG).
    if (used_llm and p.rag_context and reply and len(reply) > 50
            and p.intent in ("lgu_query", "tourism_query", "follow_up", "unknown")):
        asyncio.create_task(_auto_cache_faq(message, reply))

    # Safety Net: flag problematic queries for admin review
    if not p.faq_answer and not p.document:
        if p.intent == "unknown":
            _type = "wrong_prompt" if p.confidence < 0.3 else "low_confidence"
            flag_unknown_query(db, message, p.session.id, p.confidence, topic, flag_type=_type)
        elif not p.rag_context and topic == "lgu":
            # Valid intent but knowledge base has no answer — information gap
            flag_unknown_query(db, message, p.session.id, p.confidence, topic, flag_type="missing_info")

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
    t0 = time.monotonic()
    p = await _run_pipeline(db, message, session_id, topic)

    # First yield the metadata (intent, entities, session_id)
    metadata = {
        "session_id": p.session.id,
        "intent": p.intent,
        "confidence": round(p.confidence, 4),
        "entities": p.entities,
    }
    yield f"data: {json.dumps(metadata)}\n\n"

    # ── FAQ short-circuit: curated answer → stream it directly ──
    if p.faq_answer:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", p.faq_answer,
                    response_source="faq_cache", response_ms=elapsed_ms)
        yield f"data: {json.dumps({'text': p.faq_answer})}\n\n"
        done_meta = json.dumps({
            "session_id": p.session.id,
            "intent": p.intent,
            "confidence": round(p.confidence, 4),
            "entities": p.entities,
            "language": language,
        })
        yield f"data: [DONE]{done_meta}\n\n"
        return

    # ── Hard guard: PDID provided but not found in DTS → skip LLM entirely ──
    if "pdid" in p.entities and not p.document:
        reply = generate_response(p.intent, p.entities, p.document, p.context, topic=topic, language=language, rag_context=p.rag_context)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
        log_message(db, p.session.id, "bot", reply,
                    response_source="rag_template", response_ms=elapsed_ms)
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
    used_llm = False

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

                if full_reply:
                    used_llm = True
            except Exception as e:
                print(f"Error streaming LLM response: {e}")
            finally:
                await response_stream.aclose()

    # If no LLM streaming occurred/succeeded, fallback to template
    elapsed_ms = int((time.monotonic() - t0) * 1000)
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

    src = "llm" if used_llm else "rag_template"

    # Log the complete interaction
    log_message(db, p.session.id, "user", message, p.intent, p.confidence, p.entities)
    log_message(db, p.session.id, "bot", full_reply,
                response_source=src, response_ms=elapsed_ms)

    # Auto-cache: persist successful RAG-grounded LLM answers so future asks skip Ollama
    if (used_llm and p.rag_context and full_reply and len(full_reply) > 50
            and p.intent in ("lgu_query", "tourism_query", "follow_up", "unknown")):
        asyncio.create_task(_auto_cache_faq(message, full_reply))

    # Safety Net: flag problematic queries for admin review
    if not p.faq_answer and not p.document:
        if p.intent == "unknown":
            _type = "wrong_prompt" if p.confidence < 0.3 else "low_confidence"
            flag_unknown_query(db, message, p.session.id, p.confidence, topic, flag_type=_type)
        elif not p.rag_context and topic == "lgu":
            flag_unknown_query(db, message, p.session.id, p.confidence, topic, flag_type="missing_info")

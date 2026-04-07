import json
import os
import re
import io
import edge_tts
from langdetect import detect, detect_langs
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DBSession

from app.db.database import get_db
from app.db.models import TrainingData, FAQEntry
from app.schemas.chat import (
    ChatRequest, ChatResponse,
    TrainRequest, TrainResponse,
    HealthResponse,
    TTSRequest,
    RagIngestRequest, RagIngestResponse,
    RagDeleteRequest, RagDeleteResponse,
    RagRebuildResponse,
    TopicSelectRequest, TopicSelectResponse,
    FAQCreateRequest, FAQUpdateRequest, FAQListResponse, FAQDeleteResponse,
)
from app.services import rag_service
from app.services.conversation import process_message, stream_message, classifier
from app.services.response_generator import generate_topic_welcome
from app.config import settings
from app.rate_limiter import limiter

router = APIRouter(prefix="/api", tags=["AI Engine"])


@router.post("/chat", response_model=ChatResponse)
@limiter.limit("30/minute")
async def chat(request: Request, chat_request: ChatRequest, db: DBSession = Depends(get_db)):
    """
    Main chat endpoint.

    Send a message and get an AI-powered response about document status.
    Pass session_id from a previous response to continue a multi-turn conversation.
    """
    try:
        result = await process_message(
            db=db,
            message=chat_request.message,
            session_id=chat_request.session_id,
            language=chat_request.language,
            topic=chat_request.topic,
        )
        return ChatResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing message: {str(e)}")


@router.post("/topic-select", response_model=TopicSelectResponse)
@limiter.limit("30/minute")
async def topic_select(request: Request, payload: TopicSelectRequest, db: DBSession = Depends(get_db)):
    """
    Topic-selection endpoint.

    Called when the user chooses between 'Document Tracking' (docs) or
    'General Services' (lgu) in the chat UI. Returns a contextual welcome
    message and a session ID to use for all subsequent chat calls.
    """
    from app.services.conversation import get_or_create_session
    from app.services.chat_logger import log_message

    VALID_TOPICS = {"docs", "lgu"}
    if payload.topic not in VALID_TOPICS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid topic '{payload.topic}'. Must be one of: {', '.join(sorted(VALID_TOPICS))}"
        )

    session = get_or_create_session(db, payload.session_id)
    welcome = generate_topic_welcome(payload.topic, language=payload.language)

    # Log the bot's welcome as a chat message so history is preserved
    log_message(db, session.id, "bot", welcome)

    return TopicSelectResponse(
        reply=welcome,
        session_id=session.id,
        topic=payload.topic,
    )


async def _stream_with_error_handling(db, message, session_id, language, topic):
    """Wrap stream_message to catch and surface streaming errors as SSE events."""
    try:
        async for chunk in stream_message(
            db=db,
            message=message,
            session_id=session_id,
            language=language,
            topic=topic,
        ):
            yield chunk
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"


@router.post("/chat/stream")
@limiter.limit("30/minute")
async def chat_stream(request: Request, chat_request: ChatRequest, db: DBSession = Depends(get_db)):
    """
    Streaming chat endpoint using Server-Sent Events (SSE).

    Yields chunks of the AI's response as they are generated.
    Errors during streaming are yielded as SSE events with an "error" field.
    """
    return StreamingResponse(
        _stream_with_error_handling(
            db=db,
            message=chat_request.message,
            session_id=chat_request.session_id,
            language=chat_request.language,
            topic=chat_request.topic,
        ),
        media_type="text/event-stream"
    )


@router.post("/train", response_model=TrainResponse)
@limiter.limit("5/minute")
async def train(request: Request, train_request: TrainRequest = TrainRequest(), db: DBSession = Depends(get_db)):
    """
    Retrain the intent classifier.

    Source options:
    - csv: Train from ml_data/intent_training.csv
    - database: Train from the training_data table in the database
    """
    try:
        data = None
        csv_path = None

        if train_request.source == "database":
            # Load training data from database
            records = db.query(TrainingData).all()
            if not records:
                raise HTTPException(
                    status_code=400,
                    detail="No training data found in database. Add data to the training_data table first."
                )
            data = [(r.text, r.intent) for r in records]

        elif train_request.source == "csv":
            csv_path = os.path.join(settings.TRAINING_DATA_DIR, "intent_training.csv")
            if not os.path.exists(csv_path):
                raise HTTPException(
                    status_code=400,
                    detail=f"Training CSV not found at {csv_path}"
                )

        else:
            raise HTTPException(status_code=400, detail="Invalid source. Use 'csv' or 'database'.")

        stats = classifier.train(csv_path=csv_path, data=data)

        return TrainResponse(
            status="success",
            num_samples=stats["num_samples"],
            num_intents=stats["num_intents"],
            intents=stats["intents"],
            training_accuracy=stats["training_accuracy"],
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Training failed: {str(e)}")


@router.get("/health", response_model=HealthResponse)
async def health():
    """Check engine health and model status."""
    return HealthResponse(
        status="ok",
        model_loaded=classifier.is_loaded,
        model_intents=classifier.classes,
    )


# Allowed TTS voices
ALLOWED_VOICES = {
    "en-US-GuyNeural",         # English male
    "fil-PH-AngeloNeural",     # Filipino male
}


def _strip_markdown(text: str) -> str:
    """Strip markdown formatting and emojis from text so TTS reads cleanly."""
    # Remove bold/italic markers
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    # Remove all emojis and other pictographic symbols
    text = re.sub(
        r'[\U00010000-\U0010FFFF'   # Supplementary multilingual plane (most emojis)
        r'\U00002600-\U000027BF'    # Misc symbols (☀, ✅, etc.)
        r'\U0001F300-\U0001F9FF'    # Emoji block
        r'\u2190-\u21FF]',          # Arrows (←, →)
        '', text, flags=re.UNICODE
    )
    # Expand common abbreviations for natural TTS reading
    text = re.sub(r'\bNo\.(?=\s|$)', 'Number', text)
    # Convert single-letter initials like "L." to just "L" so TTS reads the letter naturally
    text = re.sub(r'\b([A-Z])\.\s', r'\1 ', text)
    # Convert ALL-CAPS WORDS to Title Case so TTS reads them as full words, not individual letters
    # (e.g., "MAYOR" → "Mayor", "DUMLAO" → "Dumlao")
    text = re.sub(r'\b([A-Z]{2,})\b', lambda m: m.group(1).title(), text)
    # Remove bullet points
    text = text.replace("• ", "")
    # Ignore slash signs when reading
    text = text.replace("/", " ")
    # Custom pronunciation corrections for local names/words
    _PRONUNCIATIONS = {
        r'\bYves\b': 'eves',
        r'\bII\b': 'the second',
    }
    for pattern, replacement in _PRONUNCIATIONS.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    # Convert newlines to natural pauses
    text = re.sub(r'\n+', '. ', text)
    # Clean up extra whitespace
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


@router.post("/tts")
@limiter.limit("20/minute")
async def text_to_speech(request: Request, tts_request: TTSRequest):
    """
    Convert text to speech audio (MP3).

    Accepts the AI reply text and returns an MP3 audio stream.
    Supports English and Filipino voices.

    Available voices:
    - en-US-GuyNeural (English, male - default)
    - fil-PH-AngeloNeural (Filipino, male)
    """
    # Strip markdown from text first so detection is clean
    clean_text = _strip_markdown(tts_request.text)

    if not clean_text:
        raise HTTPException(status_code=400, detail="Text is empty after cleaning.")

    # Use the user's explicit voice choice; only auto-detect when enabled
    voice = tts_request.voice

    if tts_request.auto_detect and voice == "en-US-GuyNeural":
        # Auto-detect mode — pick the best voice based on text language
        try:
            detected_lang = detect(clean_text)
            if detected_lang == 'tl':
                voice = "fil-PH-AngeloNeural"
        except Exception:
            pass  # keep default if detection fails

    if voice not in ALLOWED_VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid voice '{voice}'. Allowed: {', '.join(sorted(ALLOWED_VOICES))}"
        )

    try:
        # Generate audio using edge-tts
        communicate = edge_tts.Communicate(clean_text, voice)
        audio_buffer = io.BytesIO()

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buffer.write(chunk["data"])

        audio_buffer.seek(0)

        return StreamingResponse(
            audio_buffer,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline; filename=tts_output.mp3"}
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {str(e)}")


@router.post("/rag/ingest", response_model=RagIngestResponse)
@limiter.limit("10/minute")
async def rag_ingest(request: Request, payload: RagIngestRequest):
    """
    Ingest a document's extracted text into the live RAG index.

    Called by the Admin Dashboard immediately after a successful upload.
    The text is chunked, embedded, and appended to the in-memory index.
    The updated index is also persisted to disk (rag_cache.pkl).
    """
    try:
        chunks_added = rag_service.add_document_to_index(
            text=payload.text,
            filename=payload.filename,
        )
        return RagIngestResponse(
            success=True,
            message=f"Successfully ingested '{payload.filename}'.",
            chunks_added=chunks_added,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")


@router.post("/rag/delete", response_model=RagDeleteResponse)
@limiter.limit("10/minute")
async def rag_delete(request: Request, payload: RagDeleteRequest):
    """
    Remove a document's extracted text from the live RAG index.

    Called by the Admin Dashboard immediately after a document is deleted.
    The chunks and embeddings associated with the filename are removed from
    in-memory arrays. The updated index is then persisted to disk.
    """
    try:
        chunks_deleted = rag_service.delete_document_from_index(
            filename=payload.filename,
        )
        return RagDeleteResponse(
            success=True,
            message=f"Successfully deleted '{payload.filename}' from index.",
            chunks_deleted=chunks_deleted,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Deletion failed: {str(e)}")


@router.post("/rag/rebuild", response_model=RagRebuildResponse)
@limiter.limit("2/minute")
async def rag_rebuild(request: Request):
    """
    Force a full rebuild of the RAG index from the Admin API.
    """
    try:
        total_chunks = rag_service.rebuild_index()
        return RagRebuildResponse(
            success=True,
            message="Successfully rebuilt RAG index from Admin API.",
            total_chunks=total_chunks,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rebuild failed: {str(e)}")


# ── FAQ / Curated Answer Endpoints ────────────────────────────────────────────

@router.post("/faq", response_model=dict)
@limiter.limit("30/minute")
async def faq_create(request: Request, payload: FAQCreateRequest, db: DBSession = Depends(get_db)):
    """
    Save a curated Q&A pair to the database and immediately load it into
    the in-memory FAQ cache so the bot can use it without restarting.

    The bot checks FAQ entries before RAG. When a user's question matches a
    FAQ entry (≥72% semantic similarity), the stored answer is returned directly.
    """
    from datetime import datetime, timezone
    entry = FAQEntry(
        question=payload.question,
        answer=payload.answer,
        section=payload.section,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    # Hot-load into the in-memory cache so it's available immediately
    rag_service.add_faq_to_cache(entry.id, entry.question, entry.answer)

    return {
        "success": True,
        "message": "FAQ entry saved and loaded into bot memory.",
        "id": entry.id,
        "question": entry.question,
        "answer": entry.answer,
        "section": entry.section,
    }


@router.get("/faq", response_model=FAQListResponse)
@limiter.limit("30/minute")
async def faq_list(request: Request, db: DBSession = Depends(get_db)):
    """List all curated FAQ entries."""
    entries = db.query(FAQEntry).order_by(FAQEntry.created_at.desc()).all()
    return FAQListResponse(
        success=True,
        total=len(entries),
        entries=[
            {
                "id": e.id,
                "question": e.question,
                "answer": e.answer,
                "section": e.section,
                "created_at": e.created_at.isoformat(),
                "updated_at": e.updated_at.isoformat(),
            }
            for e in entries
        ],
    )


@router.put("/faq/{faq_id}", response_model=dict)
@limiter.limit("30/minute")
async def faq_update(request: Request, faq_id: int, payload: FAQUpdateRequest, db: DBSession = Depends(get_db)):
    """
    Update an existing FAQ entry. Refreshes the in-memory cache automatically.
    """
    entry = db.query(FAQEntry).filter(FAQEntry.id == faq_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"FAQ entry {faq_id} not found.")

    if payload.question is not None:
        entry.question = payload.question
    if payload.answer is not None:
        entry.answer = payload.answer
    if payload.section is not None:
        entry.section = payload.section

    db.commit()
    db.refresh(entry)

    # Rebuild cache entry: remove old, add updated
    rag_service.remove_faq_from_cache(faq_id)
    rag_service.add_faq_to_cache(entry.id, entry.question, entry.answer)

    return {
        "success": True,
        "message": "FAQ entry updated.",
        "id": entry.id,
        "question": entry.question,
        "answer": entry.answer,
        "section": entry.section,
    }


@router.delete("/faq/{faq_id}", response_model=FAQDeleteResponse)
@limiter.limit("30/minute")
async def faq_delete(request: Request, faq_id: int, db: DBSession = Depends(get_db)):
    """Delete a FAQ entry and remove it from the bot's memory immediately."""
    entry = db.query(FAQEntry).filter(FAQEntry.id == faq_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"FAQ entry {faq_id} not found.")

    db.delete(entry)
    db.commit()
    rag_service.remove_faq_from_cache(faq_id)

    return FAQDeleteResponse(success=True, message=f"FAQ entry {faq_id} deleted.")

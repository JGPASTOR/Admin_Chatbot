import json
import logging
import os
import re
import io
import edge_tts

logger = logging.getLogger(__name__)
from langdetect import detect, detect_langs
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DBSession

from app.db.database import get_db
from app.db.models import TrainingData, FAQEntry, FlaggedQuery
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
    FAQSuggestRequest,
    FlaggedQueryResolveRequest, FlaggedQueryResponse,
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
    The text is chunked, embedded, and stored in ChromaDB.
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

@router.post("/faq/generate", response_model=dict)
@limiter.limit("5/minute")
async def faq_generate_llm(request: Request, payload: FAQSuggestRequest):
    """
    Qwen3-powered training data generation from document text.

    For each document chunk, Qwen3 generates:
      • 1 canonical answer
      • 1 primary direct question
      • 3-4 related questions (different angles / adjacent topics)
      • 3-4 question variations (same meaning, different phrasing)

    All questions share the same canonical answer. This gives the RAG
    semantic matcher many entry points — users can phrase a question any
    way they like and still get the right answer.

    Confidence is scored against text evidence, not a vague scale:
      10   — answer is a direct quote / exact fact from the text
      8-9  — answer clearly stated in text, no ambiguity
      6-7  — answer derivable from text with minor synthesis
      4-5  — answer implied but not explicit (pending review)
      1-3  — answer not in text → discarded automatically

    Auto-approve threshold: ≥ 8  (straight to FAQ, no manual review)
    Pending review:         5-7
    Discarded:              < 5
    """
    import httpx
    import json as json_lib
    from app.services.rag_service import _chunk_text

    text = payload.text.strip()
    filename = payload.filename or "document"

    if not text:
        return {"success": True, "pairs": [], "total": 0}

    # Clean decorative separator lines before chunking
    import re as _re
    cleaned_lines = []
    for line in text.splitlines():
        t = line.strip()
        if _re.match(r'^([═=\-_*~─━▬])\1{2,}$', t):
            continue
        alnum = len(_re.sub(r'[^a-zA-Z0-9]', '', t))
        if len(t) > 0 and alnum / len(t) < 0.2:
            continue
        cleaned_lines.append(line)
    text = _re.sub(r'\n{3,}', '\n\n', '\n'.join(cleaned_lines)).strip()

    chunks = _chunk_text(text)
    chunks = [c.strip() for c in chunks if len(c.strip()) >= 120]
    selected = chunks[:30]  # up to 30 chunks per doc

    if not selected:
        return {"success": True, "pairs": [], "total": 0}

    llm_url = os.environ.get("LLM_SERVICE_URL", "http://localhost:8001")
    all_pairs = []

    # ── Step 1: Generation — 1 answer + primary + related + variations per chunk ─
    gen_system = (
        "You are a training data generator for a Philippine local government chatbot (Surigao City DTS). "
        "Your job is to read a text excerpt and produce one canonical answer plus MANY questions that lead to it.\n\n"
        "WHY: The chatbot uses semantic similarity to match user questions to stored Q&A pairs. "
        "More question variations = higher chance of matching, even when users phrase things differently.\n\n"
        "FOR EACH EXCERPT produce:\n"
        "  • primary   — the most direct, natural question a citizen would ask\n"
        "  • related   — 3 questions about adjacent or follow-up topics in the same excerpt\n"
        "  • variations — 4 different ways a citizen might ask the PRIMARY question\n"
        "All questions must share ONE canonical answer derived directly from the text.\n\n"
        "CONFIDENCE RUBRIC (be accurate — do not default to the middle):\n"
        "  10  — answer is a verbatim quote or exact numbered fact from the text\n"
        "  8-9 — answer is clearly and fully stated in the text, zero ambiguity\n"
        "  6-7 — answer is derivable from text with minor synthesis\n"
        "  4-5 — answer is implied but not explicitly written\n"
        "  1-3 — answer requires guessing or is NOT in the text\n\n"
        "OUTPUT FORMAT — a flat JSON array where each entry has:\n"
        '  {"question": "...", "answer": "...", "confidence": <int>, '
        '"section": "...", "question_type": "primary|related|variation"}\n\n'
        "STRICT RULES:\n"
        "1. All questions for the same excerpt MUST share the exact same answer string\n"
        "2. Variations must rephrase the primary, NOT introduce new facts\n"
        "3. Related questions may cover different parts of the same excerpt\n"
        "4. Never invent details not found in the text\n"
        "5. If the excerpt is just a header/signature with no real content, return []\n"
        "6. Return ONLY the JSON array — no markdown, no explanation"
    )

    # Process 2 chunks per batch (larger output per chunk needs more context window)
    batch_size = 2
    for batch_idx in range(0, len(selected), batch_size):
        batch = selected[batch_idx: batch_idx + batch_size]
        numbered = "\n\n---\n\n".join(
            f"[Excerpt {batch_idx + j + 1}]:\n{c}" for j, c in enumerate(batch)
        )

        prompt = (
            f"Document: {filename}\n\n"
            f"Text excerpts:\n{numbered}\n\n"
            f"For EACH excerpt above, generate:\n"
            f"  • 1 primary question + canonical answer\n"
            f"  • 3 related questions (same answer)\n"
            f"  • 4 variation questions (same answer, different phrasing of the primary)\n\n"
            f"That is ~8 entries per excerpt. All sharing ONE answer per excerpt.\n\n"
            f"section field = the section label from the excerpt (e.g. 'Section 2', 'Eligibility', etc.)\n"
            f"question_type = 'primary', 'related', or 'variation'\n\n"
            f"Return ONLY the flat JSON array."
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                res = await client.post(
                    f"{llm_url}/api/generate",
                    json={"prompt": prompt, "system_prompt": gen_system},
                )
                res.raise_for_status()
                raw = res.json().get("response", "").strip()

                json_match = re.search(r'\[[\s\S]*?\]', raw)
                if json_match:
                    pairs = json_lib.loads(json_match.group(0))
                    if isinstance(pairs, list):
                        for p in pairs:
                            if not isinstance(p, dict):
                                continue
                            q = str(p.get("question", "")).strip()
                            a = str(p.get("answer", "")).strip()
                            if not q or not a or len(a) < 10:
                                continue
                            try:
                                conf = max(1, min(10, int(float(p.get("confidence", 5)))))
                            except (ValueError, TypeError):
                                conf = 5
                            if conf < 4:
                                continue  # discard evidently unsupported pairs
                            all_pairs.append({
                                "question": q,
                                "answer": a,
                                "confidence": conf,
                                "section": str(p.get("section", "")).strip(),
                                "question_type": str(p.get("question_type", "primary")).strip(),
                                "_source": numbered[:1500],
                            })

        except Exception as e:
            logger.warning(f"[FAQ Generate] Batch {batch_idx // batch_size + 1} failed: {e}")
            continue

    # ── Deduplicate by lowercased question ────────────────────────────────────
    seen_q: set = set()
    deduped = []
    for p in all_pairs:
        key = p["question"].lower().strip()
        if key not in seen_q:
            seen_q.add(key)
            deduped.append(p)

    # ── Step 2: Judge — verify each pair's answer is supported by source text ──
    judge_system = (
        "You are a strict fact-checker for a government chatbot. "
        "Verify that each Q&A pair's answer is fully supported by its source text. "
        "Mark 'drop' if the answer adds ANY detail not in the source, or if it cannot "
        "be answered from the source alone. Mark 'keep' only when the answer is clearly grounded."
    )

    verified_pairs = []
    judge_batch_size = 6
    for judge_idx in range(0, len(deduped), judge_batch_size):
        judge_batch = deduped[judge_idx: judge_idx + judge_batch_size]
        items_text = "\n\n".join(
            f"[Pair {judge_idx + k + 1}] ({p.get('question_type','primary')})\n"
            f'Source: """{p["_source"][:800]}"""\n'
            f"Q: {p['question']}\n"
            f"A: {p['answer']}"
            for k, p in enumerate(judge_batch)
        )
        judge_prompt = (
            f"Review each Q&A pair. For each:\n"
            f"1. Is the answer fully supported by the source text?\n"
            f"2. Does it add any invented details?\n\n"
            f"{items_text}\n\n"
            f'Return JSON array: [{{"id": 1, "verdict": "keep"}}, {{"id": 2, "verdict": "drop"}}]\n'
            f"verdict = 'keep' or 'drop' only. Return ONLY the JSON array."
        )

        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                res = await client.post(
                    f"{llm_url}/api/generate",
                    json={"prompt": judge_prompt, "system_prompt": judge_system},
                )
                res.raise_for_status()
                raw = res.json().get("response", "").strip()

                json_match = re.search(r'\[[\s\S]*?\]', raw)
                if json_match:
                    verdicts = json_lib.loads(json_match.group(0))
                    if isinstance(verdicts, list):
                        verdict_map = {int(v.get("id", 0)): v for v in verdicts if isinstance(v, dict)}
                        for k, p in enumerate(judge_batch):
                            pair_num = judge_idx + k + 1
                            vdict = verdict_map.get(pair_num, {})
                            if vdict.get("verdict", "keep").lower() != "drop":
                                verified_pairs.append(p)
                            else:
                                logger.info(f"[FAQ Judge] Dropped: '{p['question'][:60]}'")
                    else:
                        verified_pairs.extend(judge_batch)
                else:
                    verified_pairs.extend(judge_batch)

        except Exception as e:
            logger.warning(f"[FAQ Judge] Batch {judge_idx // judge_batch_size + 1} failed: {e}")
            verified_pairs.extend(judge_batch)

    # Strip internal field, sort by confidence, return all (no arbitrary cap)
    for p in verified_pairs:
        p.pop("_source", None)

    verified_pairs.sort(key=lambda x: (x["confidence"], x.get("question_type") == "primary"), reverse=True)

    logger.info(
        f"[FAQ Generate] '{filename}': {len(all_pairs)} raw → "
        f"{len(deduped)} deduped → {len(verified_pairs)} passed judge"
    )
    return {
        "success": True,
        "pairs": verified_pairs,
        "total": len(verified_pairs),
        "breakdown": {
            "primary": sum(1 for p in verified_pairs if p.get("question_type") == "primary"),
            "related": sum(1 for p in verified_pairs if p.get("question_type") == "related"),
            "variation": sum(1 for p in verified_pairs if p.get("question_type") == "variation"),
        },
    }


@router.post("/faq/suggest", response_model=dict)
@limiter.limit("20/minute")
async def faq_suggest(request: Request, payload: FAQSuggestRequest):
    """
    Parse a document's extracted text into proposed FAQ entries.

    Splits on SECTION headers and returns a list of {section, question, answer}
    objects ready for the admin to review and save. No LLM required — pure
    text extraction so it works even when the LLM is offline.
    """
    text = payload.text.strip()
    filename = payload.filename or "document"

    # Split on SECTION headers (e.g. "SECTION 1 — LGU VISION", "Section 2.")
    section_pattern = re.compile(r'(?=\bSECTION\s+\d+\b)', re.IGNORECASE)
    raw_sections = section_pattern.split(text)

    proposals = []
    for raw in raw_sections:
        raw = raw.strip()
        if not raw:
            continue

        lines = raw.splitlines()
        # First non-empty line is the section header
        header = next((l.strip() for l in lines if l.strip()), "")
        if not header:
            continue

        # Body = everything after the header, trimmed
        body_lines = lines[1:]
        body = "\n".join(l for l in body_lines if l.strip()).strip()

        if not body:
            # Header-only section (no content) — still propose it so admin can fill in the answer
            body = header

        # Extract section number for the label
        num_match = re.search(r'section\s+(\d+)', header, re.IGNORECASE)
        section_label = f"Section {num_match.group(1)}" if num_match else header[:40]

        # Generate a natural question from the header
        # Remove "SECTION N —" prefix, keep the topic part
        topic = re.sub(r'^\s*SECTION\s+\d+\s*[—\-:\.]*\s*', '', header, flags=re.IGNORECASE).strip()
        if topic:
            question = f"What is {topic}?" if not topic.lower().startswith("what") else topic
        else:
            question = f"What is {section_label}?"

        proposals.append({
            "section": section_label,
            "question": question,
            "answer": body[:2000],  # cap at 2000 chars to keep answers focused
            "header": header,
        })

    return {
        "success": True,
        "filename": filename,
        "total": len(proposals),
        "proposals": proposals,
    }


@router.post("/faq", response_model=dict)
@limiter.limit("30/minute")
async def faq_create(request: Request, payload: FAQCreateRequest, db: DBSession = Depends(get_db)):
    """
    Save a curated Q&A pair to the database and immediately load it into
    the in-memory FAQ cache so the bot can use it without restarting.

    The bot checks FAQ entries before RAG. When a user's question matches a
    FAQ entry (≥72% semantic similarity), the stored answer is returned directly.
    """
    # Skip insert if this question already exists (prevents duplicates)
    existing = db.query(FAQEntry).filter(
        FAQEntry.question.ilike(payload.question.strip())
    ).first()
    if existing:
        rag_service.add_faq_to_cache(existing.id, existing.question, existing.answer)
        return {
            "success": True,
            "message": "FAQ entry already exists.",
            "id": existing.id,
            "question": existing.question,
            "answer": existing.answer,
            "section": existing.section,
        }

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


@router.get("/knowledge-graph", response_model=dict)
@limiter.limit("30/minute")
async def knowledge_graph(request: Request, db: DBSession = Depends(get_db)):
    """
    Return the AI's knowledge as a force-directed graph for the admin brain visualizer.

    Nodes:
      - section  hubs  (one per unique FAQ section, larger, blue)
      - faq      nodes (one per FAQ entry, colored by confidence/type)
      - intent   nodes (one per trained intent class, purple)

    Edges:
      - section → faq  (FAQ belongs to a section)
      - intent  → faq  (FAQ question text overlaps with intent keywords)
    """
    from app.ml.intent_classifier import IntentClassifier as _IC

    entries = db.query(FAQEntry).order_by(FAQEntry.section).all()
    training = db.query(TrainingData).all()

    nodes = []
    edges = []
    node_ids: set = set()

    # ── Section hub nodes ──────────────────────────────────────────────────
    section_map: dict = {}
    for e in entries:
        sec = (e.section or "General").strip()
        if sec not in section_map:
            section_map[sec] = []
        section_map[sec].append(e)

    for sec in section_map:
        nid = f"sec::{sec}"
        nodes.append({
            "id": nid,
            "label": sec,
            "type": "section",
            "size": 16,
            "color": "#3b82f6",       # blue
            "faq_count": len(section_map[sec]),
        })
        node_ids.add(nid)

    # ── Intent hub nodes ───────────────────────────────────────────────────
    intent_counts: dict = {}
    for t in training:
        intent_counts[t.intent] = intent_counts.get(t.intent, 0) + 1

    for intent, count in intent_counts.items():
        nid = f"intent::{intent}"
        nodes.append({
            "id": nid,
            "label": intent.replace("_", " ").title(),
            "type": "intent",
            "size": 12,
            "color": "#a855f7",       # purple
            "sample_count": count,
        })
        node_ids.add(nid)

    # ── FAQ nodes + section edges ──────────────────────────────────────────
    for e in entries:
        sec = (e.section or "General").strip()
        nid = f"faq::{e.id}"
        nodes.append({
            "id": nid,
            "label": e.question[:80],
            "answer": e.answer[:300],
            "section": sec,
            "type": "faq",
            "size": 7,
            "color": "#22c55e",       # green (all approved FAQs are trusted)
            "created_at": e.created_at.isoformat(),
        })
        node_ids.add(nid)
        # Edge: section hub → this FAQ
        edges.append({"source": f"sec::{sec}", "target": nid, "weight": 1.5})

    # ── Intent → FAQ edges (keyword overlap heuristic) ─────────────────────
    INTENT_KEYWORDS = {
        "document_status": ["status", "track", "document", "pdid", "tracking", "where"],
        "lgu_query":       ["ordinance", "service", "office", "government", "city", "lgu"],
        "help":            ["help", "assist", "what can", "how to use"],
        "complaint":       ["complaint", "problem", "issue", "delay", "concern"],
        "follow_up":       ["follow", "update", "check", "again", "still"],
    }
    for e in entries:
        q_lower = e.question.lower()
        for intent, keywords in INTENT_KEYWORDS.items():
            intent_nid = f"intent::{intent}"
            if intent_nid in node_ids and any(kw in q_lower for kw in keywords):
                edges.append({"source": intent_nid, "target": f"faq::{e.id}", "weight": 0.5})
                break  # one intent edge per FAQ max

    return {
        "success": True,
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "total_nodes": len(nodes),
            "total_edges": len(edges),
            "sections": len(section_map),
            "faqs": len(entries),
            "intents": len(intent_counts),
        },
    }


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


# ── Flagged Queries (Safety Net) ──────────────────────────────────────────────

@router.get("/flagged-queries", response_model=dict)
@limiter.limit("30/minute")
async def flagged_queries_list(
    request: Request,
    status: str = "pending",
    db: DBSession = Depends(get_db),
):
    """
    List flagged queries — questions the bot couldn't confidently answer.

    Status options: pending | resolved | dismissed
    """
    valid = {"pending", "resolved", "dismissed"}
    if status not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid status. Use: {', '.join(valid)}")

    entries = (
        db.query(FlaggedQuery)
        .filter(FlaggedQuery.status == status)
        .order_by(FlaggedQuery.asked_at.desc())
        .all()
    )

    return {
        "success": True,
        "total": len(entries),
        "entries": [
            {
                "id": e.id,
                "question": e.question,
                "session_id": e.session_id,
                "confidence": round(e.confidence, 4),
                "topic": e.topic,
                "flag_type": e.flag_type or "low_confidence",
                "asked_at": e.asked_at.isoformat(),
                "status": e.status,
                "admin_answer": e.admin_answer,
                "resolved_at": e.resolved_at.isoformat() if e.resolved_at else None,
            }
            for e in entries
        ],
    }


@router.get("/flagged-queries/count", response_model=dict)
@limiter.limit("60/minute")
async def flagged_queries_count(request: Request, db: DBSession = Depends(get_db)):
    """Return the count of pending flagged queries (used for sidebar badge)."""
    count = db.query(FlaggedQuery).filter(FlaggedQuery.status == "pending").count()
    return {"success": True, "pending": count}


@router.patch("/flagged-queries/{query_id}/resolve", response_model=dict)
@limiter.limit("20/minute")
async def flagged_query_resolve(
    request: Request,
    query_id: int,
    payload: FlaggedQueryResolveRequest,
    db: DBSession = Depends(get_db),
):
    """
    Admin resolves a flagged query by providing an answer.

    The question + answer are automatically saved as a new FAQ entry and
    hot-loaded into the bot's memory so it can answer correctly from now on.
    """
    from datetime import datetime, timezone

    entry = db.query(FlaggedQuery).filter(FlaggedQuery.id == query_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"Flagged query {query_id} not found.")
    if entry.status != "pending":
        raise HTTPException(status_code=400, detail=f"Query is already {entry.status}.")

    # Save to FAQ entries so the bot learns this answer
    faq = FAQEntry(
        question=entry.question,
        answer=payload.answer,
        section=payload.section,
    )
    db.add(faq)
    db.flush()  # Get the new FAQ id before commit

    # Mark flagged query as resolved
    entry.status = "resolved"
    entry.admin_answer = payload.answer
    entry.resolved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(faq)

    # Hot-load into in-memory FAQ cache immediately
    rag_service.add_faq_to_cache(faq.id, faq.question, faq.answer)

    return {
        "success": True,
        "message": "Query resolved and answer added to bot FAQ memory.",
        "faq_id": faq.id,
        "question": entry.question,
        "answer": payload.answer,
    }


@router.post("/flagged-queries/{query_id}/suggest-answer", response_model=dict)
@limiter.limit("10/minute")
async def flagged_query_suggest_answer(
    request: Request,
    query_id: int,
    db: DBSession = Depends(get_db),
):
    """
    Use Qwen3 (via the LLM Service) to auto-generate a suggested answer for a
    flagged query. Searches the RAG knowledge base first, then asks the model
    to draft a reply. The suggestion is returned for admin review — nothing is
    saved automatically.

    Useful for:
    - missing_info queries: model attempts an answer from available docs
    - low_confidence queries: model drafts a reply admin can approve/edit
    - wrong_prompt queries: model explains why it cannot answer
    """
    import httpx as _httpx

    entry = db.query(FlaggedQuery).filter(FlaggedQuery.id == query_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"Flagged query {query_id} not found.")

    question = entry.question
    flag_type = entry.flag_type or "low_confidence"

    # Try RAG retrieval for this question so the LLM has context
    rag_context = None
    if rag_service.is_ready():
        rag_context = rag_service.retrieve_context(query=question, top_k=3)

    llm_url = os.environ.get("LLM_SERVICE_URL", "http://localhost:8001")

    if flag_type == "wrong_prompt":
        system = (
            "You are a helpful government chatbot assistant. "
            "The user sent a message that appears off-topic or unclear. "
            "Politely explain what topics you can help with (document tracking, LGU services) "
            "and gently ask them to rephrase or clarify."
        )
        prompt = f"Off-topic or unclear message received: \"{question}\"\n\nDraft a polite, helpful response."
    elif rag_context:
        system = (
            "You are a government chatbot assistant for Surigao City DTS. "
            "Answer the citizen's question using ONLY the document excerpts provided. "
            "Be concise, factual, and helpful. If the excerpts don't fully answer the question, "
            "say so and suggest contacting the office directly."
        )
        prompt = (
            f"Citizen question: \"{question}\"\n\n"
            f"--- Document Excerpts ---\n{rag_context}\n--- End of Excerpts ---\n\n"
            f"Draft a clear, helpful answer based on the excerpts above."
        )
    else:
        system = (
            "You are a government chatbot assistant for Surigao City DTS. "
            "The knowledge base has no document excerpts for this question. "
            "Provide a general helpful response and suggest the citizen contact the office "
            "or provide their tracking number if applicable."
        )
        prompt = (
            f"Citizen question: \"{question}\"\n\n"
            f"No document excerpts available. Draft a general helpful response that "
            f"acknowledges the question and guides the citizen to the right resource."
        )

    try:
        async with _httpx.AsyncClient(timeout=90.0) as client:
            res = await client.post(
                f"{llm_url}/api/generate",
                json={"prompt": prompt, "system_prompt": system},
            )
            res.raise_for_status()
            suggested_answer = res.json().get("response", "").strip()
    except Exception as e:
        logger.warning(f"[SuggestAnswer] LLM call failed for query {query_id}: {e}")
        raise HTTPException(status_code=503, detail="LLM Service unavailable. Try again later.")

    if not suggested_answer:
        raise HTTPException(status_code=502, detail="LLM returned an empty suggestion.")

    return {
        "success": True,
        "query_id": query_id,
        "question": question,
        "flag_type": flag_type,
        "suggested_answer": suggested_answer,
        "rag_used": bool(rag_context),
        "message": "Review and edit the suggestion, then use the resolve endpoint to save it as a FAQ.",
    }


@router.delete("/flagged-queries/{query_id}", response_model=dict)
@limiter.limit("20/minute")
async def flagged_query_dismiss(
    request: Request,
    query_id: int,
    db: DBSession = Depends(get_db),
):
    """Dismiss a flagged query (mark as dismissed — no answer needed)."""
    entry = db.query(FlaggedQuery).filter(FlaggedQuery.id == query_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"Flagged query {query_id} not found.")

    entry.status = "dismissed"
    db.commit()

    return {"success": True, "message": f"Flagged query {query_id} dismissed."}

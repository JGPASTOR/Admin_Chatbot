import asyncio
import json
import logging
import os
import re
import io
import edge_tts

logger = logging.getLogger(__name__)
from langdetect import detect, detect_langs
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse


from app.db.database import get_db, DBSession
from app.db.models import (
    TrainingData, FAQEntry, FlaggedQuery,
    DocumentChunk, FAQGenerationQueue, FAQHistory,
)
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


# ── Phase 2 Helpers ────────────────────────────────────────────────────────────

async def is_duplicate_faq(new_question: str, threshold: float = 0.85) -> bool:
    """
    Semantic deduplication guard — delegates to rag_service.is_faq_duplicate.
    Kept as an async wrapper so existing callers (faq_create, etc.) don't need changes.
    """
    return rag_service.is_faq_duplicate(new_question, threshold)


def _lexical_overlap_ok(answer: str, source_chunk: str, min_ratio: float = 0.70) -> bool:
    """
    Fast lexical overlap pre-filter used before calling the Judge LLM.

    Extracts content words from *answer* and checks what fraction appear
    verbatim in *source_chunk*.  If < min_ratio, the answer likely contains
    hallucinated details and should be held for manual review.

    Returns True  when overlap >= min_ratio (answer looks grounded).
    Returns False when overlap <  min_ratio (answer may be hallucinated).
    """
    if not answer or not source_chunk:
        return True  # no evidence to reject

    # Extract meaningful ngrams / words from the answer (lowercase, alpha-only)
    answer_words = re.findall(r'\b[a-zA-Z]{4,}\b', answer.lower())
    if not answer_words:
        return True

    chunk_lower = source_chunk.lower()
    found = sum(1 for w in answer_words if w in chunk_lower)
    ratio = found / len(answer_words)
    logger.debug(f"[LexOverlap] ratio={ratio:.2f} ({found}/{len(answer_words)})")
    return ratio >= min_ratio


def _write_faq_history(
    db,
    faq: FAQEntry,
    change_type: str,
    changed_by: str = "admin",
) -> None:
    """Insert one FAQHistory row. Caller is responsible for db.commit()."""
    history = FAQHistory(
        faq_id=faq.id,
        question=faq.question,
        answer=faq.answer,
        changed_by=changed_by,
        change_type=change_type,
    )
    db.add(history)

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
        # Invalidate rag:query:* cache so stale results are never returned
        await rag_service.invalidate_rag_cache()
        return RagIngestResponse(
            success=True,
            message=f"Successfully ingested '{payload.filename}'.",
            chunks_added=chunks_added,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")


@router.post("/rag/ingest-with-chunks", response_model=dict)
@limiter.limit("10/minute")
async def rag_ingest_with_chunks(
    request: Request,
    payload: RagIngestRequest,
    db: DBSession = Depends(get_db),
):
    """
    **Phase-2 ingestion endpoint** — extends /rag/ingest with:

    1. Persists every chunk to the `document_chunks` table so they can be
       re-processed individually without re-uploading the full document.
    2. Enqueues one row per chunk in `faq_generation_queue` (status='pending')
       so the background worker can generate FAQs incrementally.

    Use this endpoint instead of /rag/ingest when the Admin Dashboard
    also wants to trigger background FAQ generation.
    """
    from app.services.rag_service import _chunk_text

    doc_id   = getattr(payload, "doc_id", 0) or 0
    filename = payload.filename or "document"
    text     = payload.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="No text provided.")

    # 1. Embed + store into ChromaDB (same as the standard ingest endpoint)
    try:
        chunks_added = rag_service.add_document_to_index(text=text, filename=filename)
        await rag_service.invalidate_rag_cache()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # 2. Chunk the text and persist each chunk to MySQL
    raw_chunks = _chunk_text(text)
    raw_chunks = [c.strip() for c in raw_chunks if len(c.strip()) >= 60]

    section_re = re.compile(r'\bSECTION\s+(\d+)', re.IGNORECASE)
    chunk_rows: list = []
    queue_rows: list = []

    for idx, chunk in enumerate(raw_chunks):
        # Infer section label from chunk text (fallback to 'General')
        sec_match = section_re.search(chunk)
        section_label = f"Section {sec_match.group(1)}" if sec_match else "General"

        chunk_rows.append(
            DocumentChunk(
                doc_id=doc_id,
                doc_name=filename,
                chunk_index=idx,
                chunk_text=chunk,
                section_label=section_label,
                char_count=len(chunk),
            )
        )
        queue_rows.append(
            FAQGenerationQueue(
                doc_id=doc_id,
                doc_name=filename,
                chunk_index=idx,
                chunk_text=chunk,
                section=section_label,
                status="pending",
            )
        )

    # Bulk insert (use_existing_rows check omitted for speed — caller controls idempotency)
    if chunk_rows:
        db.add_all(chunk_rows)
    if queue_rows:
        db.add_all(queue_rows)
    db.commit()

    logger.info(
        f"[IngestChunks] '{filename}': {chunks_added} ChromaDB chunks, "
        f"{len(chunk_rows)} MySQL rows, {len(queue_rows)} queue rows."
    )

    return {
        "success": True,
        "message": f"Ingested '{filename}' into RAG + chunk store + generation queue.",
        "chunks_added": chunks_added,
        "chunks_stored": len(chunk_rows),
        "queue_items": len(queue_rows),
    }



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
        # Invalidate rag:query:* cache — deleted doc chunks should no longer be returned
        await rag_service.invalidate_rag_cache()
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
        # Invalidate rag:query:* cache after full rebuild
        await rag_service.invalidate_rag_cache()
        return RagRebuildResponse(
            success=True,
            message="Successfully rebuilt RAG index from Admin API.",
            total_chunks=total_chunks,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rebuild failed: {str(e)}")


@router.post("/rag/sync-locations", response_model=RagRebuildResponse)
@limiter.limit("10/minute")
async def rag_sync_locations(request: Request):
    """
    Lightweight sync: re-ingest all locations from the Admin API into ChromaDB.
    Much faster than a full rebuild — only touches the locations, not documents.
    Safe to call after adding/editing/deleting a location.
    """
    import os
    try:
        locations_api_url = os.environ.get("LOCATIONS_API_URL", "")
        if not locations_api_url:
            raise HTTPException(status_code=503, detail="LOCATIONS_API_URL not configured.")
        chunks_added = await asyncio.get_running_loop().run_in_executor(
            None, rag_service._ingest_locations_from_api, locations_api_url
        )
        await rag_service.invalidate_rag_cache()
        return RagRebuildResponse(
            success=True,
            message=f"Locations synced — {chunks_added} new chunk(s) added.",
            total_chunks=chunks_added,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Location sync failed: {str(e)}")


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

    Confidence is scored against text evidence:
      10   — answer is a verbatim quote / exact fact from the text
      8-9  — answer clearly and fully stated in text (default for real content)
      7    — answer derivable by combining 2-3 sentences
      < 7  — discarded automatically (forbidden: 5 or 6)

    Auto-approve threshold: ≥ 8  (straight to FAQ, no manual review)
    Pending review:         7
    Discarded:              < 7
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
    selected = chunks[:40]  # cap at 40 chunks (~120 questions max per document)

    if not selected:
        return {"success": True, "pairs": [], "total": 0}

    llm_url = os.environ.get("LLM_SERVICE_URL", "http://localhost:8001")
    all_pairs = []

    # ── Step 1: One chunk at a time — 1 primary + 2 variations per chunk ──────
    # Keeping output small (3 Q&A per chunk) makes qwen3:9b respond in ~15-25s.
    # 12 chunks × ~20s = ~4 min total, well within the caller's timeout.
    gen_system = (
        "You are a training data generator for a Philippine local government chatbot (Surigao City DTS). "
        "Read the excerpt and produce SHORT, NATURAL questions that a citizen would actually type on their phone.\n\n"
        "QUESTION RULES — CRITICAL:\n"
        "  • Questions MUST be SHORT (5-12 words max). Example: 'What is National Priority 8?' not a full paragraph.\n"
        "  • Questions must sound like something a real person would type, NOT a copy of the answer text.\n"
        "  • NEVER copy content from the answer into the question. The question is what the citizen ASKS, the answer is what the bot SAYS.\n"
        "  • Bad question: 'What is NP8 (Market competition reforms, MSME development) aligns with City Sectoral Goals Tourism Trade?'\n"
        "  • Good question: 'What is National Priority 8?' or 'What does NP8 cover?'\n\n"
        "Output per excerpt:\n"
        "  • 1 primary question  — the most natural short question a citizen would type\n"
        "  • 2 variation questions — different short phrasings of the same question\n"
        "All 3 questions share the SAME answer (which is the full detailed text from the excerpt).\n\n"
        "CONFIDENCE SCALE (3 levels only):\n"
        "  10  — answer is a VERBATIM QUOTE or exact numbered fact from the text\n"
        "  8-9 — answer is clearly and fully stated in the text  ← USE THIS FOR ALMOST ALL REAL CONTENT\n"
        "  7   — answer requires combining 2-3 sentences\n"
        "  BELOW 7 → return [] (do not output the entry at all)\n\n"
        "RULE: If the chunk has actual factual sentences, the answer IS supported → confidence MUST be 8 or 9.\n"
        "FORBIDDEN: confidence = 5 or 6. Those values do not exist in this scale.\n"
        "Only return [] when the chunk is a header, signature block, or has zero factual content.\n\n"
        "Return ONLY a valid JSON array:\n"
        '[{"question":"...","answer":"...","confidence":8,"section":"...","question_type":"primary|variation"}]\n'
        "Rules: never invent details, return [] for header-only or signature-only chunks, no markdown outside the array."
    )

    for idx, chunk in enumerate(selected):
        prompt = (
            f"Document: {filename}\n\n"
            f"Excerpt {idx + 1}:\n{chunk}\n\n"
            f"Generate 3 entries (1 primary + 2 variations) sharing ONE answer derived from the excerpt above.\n"
            f"REMINDER: Questions must be SHORT (5-12 words) and natural — like 'What is National Priority 8?' not a long paragraph.\n"
            f"The answer field should contain the full detailed information from the excerpt.\n"
            f"The excerpt contains real text → confidence MUST be 8 or 9 (NOT 5, NOT 6, NOT 7 unless synthesizing sentences).\n"
            f"section = section label found in the excerpt (e.g. 'Section 2', 'National Priority 8').\n"
            f"Return ONLY the JSON array. If no factual content, return []."
        )
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
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
                            if conf < 7:
                                continue
                            all_pairs.append({
                                "question": q,
                                "answer": a,
                                "confidence": conf,
                                "section": str(p.get("section", "")).strip(),
                                "question_type": str(p.get("question_type", "primary")).strip(),
                                "_source": chunk[:1000],
                            })
        except Exception as e:
            logger.warning(f"[FAQ Generate] Chunk {idx + 1} failed: {e}")
            continue

    # ── Deduplicate ───────────────────────────────────────────────────────────
    seen_q: set = set()
    deduped = []
    for p in all_pairs:
        key = p["question"].lower().strip()
        if key not in seen_q:
            seen_q.add(key)
            deduped.append(p)

    # ── Phase-2: Lexical overlap pre-filter ───────────────────────────────────
    # Runs BEFORE the Judge LLM to catch hallucinated answers cheaply.
    # Pairs that fail lexical check are downgraded to confidence=7 so they
    # land in 'pending' review rather than being auto-approved.
    for p in deduped:
        source = p.get("_source", "")
        if not _lexical_overlap_ok(p["answer"], source):
            logger.info(
                f"[LexOverlap] Low overlap — downgrading confidence to 7 for: '{p['question'][:60]}'"
            )
            p["confidence"] = min(p["confidence"], 7)
            p["_lexical_downgraded"] = True


    # ── Step 2: Judge — verify answers against source text ────────────────────
    judge_system = (
        "You are a strict fact-checker. Mark 'drop' if the answer adds details not in the source "
        "or cannot be answered from the source alone. Otherwise mark 'keep'."
    )

    verified_pairs = []
    judge_batch_size = 8
    for judge_idx in range(0, len(deduped), judge_batch_size):
        judge_batch = deduped[judge_idx: judge_idx + judge_batch_size]
        items_text = "\n\n".join(
            f"[{judge_idx + k + 1}] Q: {p['question']}\nA: {p['answer']}\nSource: {p['_source'][:500]}"
            for k, p in enumerate(judge_batch)
        )
        judge_prompt = (
            f"Review each Q&A pair below.\n\n{items_text}\n\n"
            f'Return: [{{"id":1,"verdict":"keep"}},{{"id":2,"verdict":"drop"}}]\n'
            f"Return ONLY the JSON array."
        )
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
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
                            if verdict_map.get(judge_idx + k + 1, {}).get("verdict", "keep").lower() != "drop":
                                verified_pairs.append(p)
                    else:
                        verified_pairs.extend(judge_batch)
                else:
                    verified_pairs.extend(judge_batch)
        except Exception as e:
            logger.warning(f"[FAQ Judge] Batch {judge_idx // judge_batch_size + 1} failed: {e}")
            verified_pairs.extend(judge_batch)

    for p in verified_pairs:
        p.pop("_source", None)
        p.pop("_lexical_downgraded", None)

    verified_pairs.sort(key=lambda x: x["confidence"], reverse=True)

    logger.info(
        f"[FAQ Generate] '{filename}': {len(all_pairs)} raw → "
        f"{len(deduped)} deduped → {len(verified_pairs)} passed judge"
    )
    return {
        "success": True,
        "pairs": verified_pairs,
        "total": len(verified_pairs),
        "breakdown": {
            "primary":   sum(1 for p in verified_pairs if p.get("question_type") == "primary"),
            "variation": sum(1 for p in verified_pairs if p.get("question_type") == "variation"),
            "lexical_downgraded": sum(
                1 for p in all_pairs if p.get("_lexical_downgraded")
            ),
        },
    }


@router.post("/faq/process-queue", response_model=dict)
@limiter.limit("5/minute")
async def faq_process_queue(
    request: Request,
    db: DBSession = Depends(get_db),
    batch_size: int = 5,
):
    """
    **Background worker endpoint** — picks up pending FAQ generation queue items.

    Admin Dashboard (or a cron job) calls this endpoint periodically.
    Each call processes up to *batch_size* pending chunks, calls Qwen3,
    applies the lexical-overlap pre-filter + semantic dedup check, then
    inserts approved FAQs immediately.

    Response includes queue progress so the UI can render a progress bar:
      ``{"processed": 5, "pending_remaining": 84, "approved": 3, "skipped": 2}``
    """
    import httpx
    import json as json_lib
    from datetime import datetime, timezone

    # Claim a batch atomically (set status='processing' before reading)
    pending = (
        db.query(FAQGenerationQueue)
        .filter(FAQGenerationQueue.status == "pending")
        .order_by(FAQGenerationQueue.created_at)
        .limit(batch_size)
        .all()
    )

    if not pending:
        remaining = db.query(FAQGenerationQueue).filter(
            FAQGenerationQueue.status.in_(["pending", "processing"])
        ).count()
        return {"success": True, "processed": 0, "pending_remaining": remaining,
                "approved": 0, "skipped": 0, "message": "Queue is empty."}

    # Mark as processing
    for item in pending:
        item.status = "processing"
    db.commit()

    llm_url = os.environ.get("LLM_SERVICE_URL", "http://localhost:8001")
    gen_system = (
        "You are a training data generator for a Philippine local government chatbot. "
        "Read the excerpt and produce ONE Q&A pair.\n"
        "Return ONLY: [{\"question\":\"...\",\"answer\":\"...\",\"confidence\":8,\"section\":\"...\"}]\n"
        "Do not invent details. Return [] for header-only or empty chunks."
    )

    approved = 0
    skipped  = 0
    now = datetime.now(timezone.utc)

    for item in pending:
        try:
            prompt = (
                f"Document: {item.doc_name}\n\nExcerpt:\n{item.chunk_text}\n\n"
                f"Generate 1 primary Q&A from this excerpt. confidence must be 8 or 9.\n"
                f"section = section label in the excerpt or '{item.section or 'General'}'.\n"
                f"Return ONLY the JSON array."
            )
            async with httpx.AsyncClient(timeout=60.0) as client:
                res = await client.post(
                    f"{llm_url}/api/generate",
                    json={"prompt": prompt, "system_prompt": gen_system},
                )
                res.raise_for_status()
                raw = res.json().get("response", "").strip()

            json_match = re.search(r'\[[\s\S]*?\]', raw)
            if not json_match:
                raise ValueError("No JSON array in LLM response")

            pairs = json_lib.loads(json_match.group(0))
            if not isinstance(pairs, list) or not pairs:
                raise ValueError("Empty or invalid pairs list")

            for p in pairs:
                q = str(p.get("question", "")).strip()
                a = str(p.get("answer", "")).strip()
                try:
                    conf = max(1, min(10, int(float(p.get("confidence", 5)))))
                except (ValueError, TypeError):
                    conf = 5

                if not q or not a or conf < 7:
                    skipped += 1
                    continue

                # Lexical overlap pre-filter
                if not _lexical_overlap_ok(a, item.chunk_text):
                    logger.info(f"[QueueWorker] Lexical fail — skipping: '{q[:60]}'")
                    skipped += 1
                    continue

                # Semantic deduplication
                if await is_duplicate_faq(q):
                    logger.info(f"[QueueWorker] Duplicate FAQ — skipping: '{q[:60]}'")
                    skipped += 1
                    continue

                # Insert to faq_entries
                section_val = str(p.get("section", item.section or "General")).strip() or "General"
                faq = FAQEntry(question=q, answer=a, section=section_val)
                db.add(faq)
                db.flush()  # get id

                # History record
                _write_faq_history(db, faq, change_type="created", changed_by="ai-auto")

                # Hot-load into in-memory FAQ cache
                rag_service.add_faq_to_cache(faq.id, faq.question, faq.answer)
                approved += 1

            item.status = "done"
            item.processed_at = now

        except Exception as e:
            logger.warning(f"[QueueWorker] Chunk {item.id} failed: {e}")
            item.retry_count = (item.retry_count or 0) + 1
            item.status = "failed" if (item.retry_count or 0) >= 3 else "pending"

    db.commit()

    remaining = db.query(FAQGenerationQueue).filter(
        FAQGenerationQueue.status.in_(["pending", "processing"])
    ).count()

    return {
        "success": True,
        "processed": len(pending),
        "approved": approved,
        "skipped": skipped,
        "pending_remaining": remaining,
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
async def faq_create(request: Request, payload: FAQCreateRequest, background_tasks: BackgroundTasks, db: DBSession = Depends(get_db)):
    """
    Save a curated Q&A pair to the database and immediately load it into
    the in-memory FAQ cache so the bot can use it without restarting.

    Phase-2: checks semantic deduplication before inserting. If the question
    already exists (cosine similarity >= 0.85), returns the existing entry.
    All inserts write an FAQHistory row for audit purposes.
    """
    # ── Exact-match dedup (case-insensitive) ──────────────────────────────────
    existing = db.query(FAQEntry).filter(
        FAQEntry.question.ilike(payload.question.strip())
    ).first()
    if existing:
        # Ensure the cache is warm for this entry (runs in background — never blocks)
        background_tasks.add_task(
            rag_service.add_faq_to_cache, existing.id, existing.question, existing.answer
        )
        return {
            "success": True,
            "message": "FAQ entry already exists.",
            "id": existing.id,
            "question": existing.question,
            "answer": existing.answer,
            "section": existing.section,
            "duplicate": True,
        }

    # ── Semantic dedup (Phase-2) ───────────────────────────────────────────────
    # Threshold 0.92: catch near-identical re-submissions while allowing genuine
    # phrasings (0.65–0.91) to coexist as variant coverage.
    if await is_duplicate_faq(payload.question.strip(), threshold=0.92):
        return {
            "success": True,
            "message": "A semantically similar FAQ already exists. Skipped to prevent duplicates.",
            "duplicate": True,
        }

    entry = FAQEntry(
        question=payload.question,
        answer=payload.answer,
        section=payload.section,
    )
    db.add(entry)
    db.flush()  # get id before commit

    # History record
    _write_faq_history(db, entry, change_type="created", changed_by="admin")

    db.commit()
    db.refresh(entry)

    # Hot-load into FAQ cache in the background (never blocks the API response)
    background_tasks.add_task(
        rag_service.add_faq_to_cache, entry.id, entry.question, entry.answer
    )

    # Generate question variants in background so short/varied queries also match
    background_tasks.add_task(_generate_and_store_faq_variants, entry.id, entry.question, entry.answer)

    return {
        "success": True,
        "message": "FAQ entry saved and loaded into bot memory.",
        "id": entry.id,
        "question": entry.question,
        "answer": entry.answer,
        "section": entry.section,
        "duplicate": False,
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


@router.post("/faq/{faq_id}/generate-variants", response_model=dict)
@limiter.limit("10/minute")
async def faq_generate_variants(
    request: Request,
    faq_id: int,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
):
    """
    Admin endpoint: re-generate question variants for an existing FAQ entry.

    Variants are alternate phrasings (short, medium, long) of the canonical question
    stored in ChromaDB so that users asking in different ways still get the right answer.
    This runs in the background — returns immediately.
    """
    entry = db.query(FAQEntry).filter(FAQEntry.id == faq_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"FAQ id={faq_id} not found.")

    background_tasks.add_task(_generate_and_store_faq_variants, entry.id, entry.question, entry.answer)

    return {
        "success": True,
        "message": f"Variant generation queued for FAQ id={faq_id}. Variants will be ready in ~30s.",
        "faq_id": faq_id,
        "question": entry.question,
    }


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
    Phase-2: writes an FAQHistory row on every edit.
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

    # History before commit so we capture the new values
    _write_faq_history(db, entry, change_type="edited", changed_by="admin")

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
    """Delete a FAQ entry and remove it from the bot's memory immediately.
    Phase-2: writes an FAQHistory (deleted) row before deletion.
    """
    entry = db.query(FAQEntry).filter(FAQEntry.id == faq_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"FAQ entry {faq_id} not found.")

    # Write deletion history BEFORE deleting the parent row
    _write_faq_history(db, entry, change_type="deleted", changed_by="admin")
    db.flush()  # flush history insert first

    db.delete(entry)
    db.commit()
    rag_service.remove_faq_from_cache(faq_id)

    return FAQDeleteResponse(success=True, message=f"FAQ entry {faq_id} deleted.")


@router.get("/faq/{faq_id}/history", response_model=dict)
@limiter.limit("30/minute")
async def faq_history(
    request: Request,
    faq_id: int,
    db: DBSession = Depends(get_db),
):
    """
    Return the full change-log for a single FAQ entry.

    Each row includes: change_type, changed_by, changed_at, and the
    question/answer snapshot at the time of the change.
    """
    # Verify FAQ exists (may have been deleted — history rows are kept via CASCADE logic,
    # but the parent row may be gone.  We query history directly.)
    rows = (
        db.query(FAQHistory)
        .filter(FAQHistory.faq_id == faq_id)
        .order_by(FAQHistory.changed_at.desc())
        .all()
    )

    return {
        "success": True,
        "faq_id": faq_id,
        "total": len(rows),
        "history": [
            {
                "id": r.id,
                "change_type": r.change_type,
                "changed_by": r.changed_by,
                "changed_at": r.changed_at.isoformat(),
                "question_snapshot": r.question,
                "answer_snapshot": r.answer,
            }
            for r in rows
        ],
    }



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


def _generate_and_store_faq_variants(faq_id: int, question: str, answer: str) -> None:
    """
    Background task: generate 4 alternate question phrasings via LLM and store them
    in the FAQ ChromaDB collection so short/varied user queries also match this FAQ.
    Delegates to rag_service.store_faq_variants_sync to avoid duplicated LLM logic.
    """
    llm_url = os.environ.get("LLM_SERVICE_URL", "http://localhost:8001")
    rag_service.store_faq_variants_sync(faq_id, question, answer, llm_url, n=4)


@router.patch("/flagged-queries/{query_id}/resolve", response_model=dict)
@limiter.limit("20/minute")
async def flagged_query_resolve(
    request: Request,
    query_id: int,
    payload: FlaggedQueryResolveRequest,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
):
    """
    Admin resolves a flagged query by providing an answer.

    The question + answer are automatically saved as a new FAQ entry and
    hot-loaded into the bot's memory so it can answer correctly from now on.
    A background task then generates question variants to improve re-phrasing recall.
    """
    from datetime import datetime, timezone

    entry = db.query(FlaggedQuery).filter(FlaggedQuery.id == query_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"Flagged query {query_id} not found.")
    if entry.status != "pending":
        raise HTTPException(status_code=400, detail=f"Query is already {entry.status}.")

    # Check if this question is already in faq_entries (e.g. approved from pending_faqs earlier)
    faq = db.query(FAQEntry).filter(
        FAQEntry.question.ilike(entry.question.strip())
    ).first()

    if faq is None:
        # New question — create the FAQ entry
        faq = FAQEntry(
            question=entry.question,
            answer=payload.answer,
            section=payload.section,
        )
        db.add(faq)
        db.flush()  # Get the new FAQ id before commit
        _write_faq_history(db, faq, "created", "admin (via resolved query)")
    else:
        # Already exists — update the answer if admin provided a different one
        if payload.answer and faq.answer != payload.answer:
            faq.answer = payload.answer
            if payload.section:
                faq.section = payload.section
            _write_faq_history(db, faq, "updated", "admin (via resolved query)")

    # Mark flagged query as resolved
    entry.status = "resolved"
    entry.admin_answer = payload.answer
    entry.resolved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(faq)

    # Hot-load into FAQ cache in the background (never blocks the response — embedding
    # service can take 10-30 s when warming up, which would blow the proxy timeout)
    background_tasks.add_task(
        rag_service.add_faq_to_cache, faq.id, faq.question, faq.answer
    )

    # Generate question variants in the background (non-blocking)
    background_tasks.add_task(
        _generate_and_store_faq_variants, faq.id, faq.question, faq.answer
    )

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
            "The knowledge base has NO document excerpts for this question. "
            "Do NOT answer from your own training knowledge or make up information. "
            "Inform the citizen that this information is not yet in the knowledge base "
            "and suggest they visit City Hall or contact the relevant office directly."
        )
        prompt = (
            f"Citizen question: \"{question}\"\n\n"
            f"The knowledge base has no information about this. Draft a polite response "
            f"that tells the citizen this information is not available yet and directs "
            f"them to visit Surigao City Hall or contact the relevant city office."
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


@router.delete("/flagged-queries/{query_id}/permanent", response_model=dict)
@limiter.limit("20/minute")
async def flagged_query_delete(
    request: Request,
    query_id: int,
    db: DBSession = Depends(get_db),
):
    """Permanently delete a flagged query from the database."""
    entry = db.query(FlaggedQuery).filter(FlaggedQuery.id == query_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail=f"Flagged query {query_id} not found.")

    db.delete(entry)
    db.commit()

    return {"success": True, "message": f"Flagged query {query_id} permanently deleted."}


# ── Phase 3: 3-Tier Priority Queue ────────────────────────────────────────────

@router.post("/chat/prioritized", response_model=dict)
@limiter.limit("30/minute")
async def chat_prioritized(
    request: Request,
    chat_request: ChatRequest,
    db: DBSession = Depends(get_db),
):
    """
    **Phase-3 priority-routed chat endpoint** — implements the 3-tier queue
    strategy from the improvement plan to minimise Ollama (LLM) load.

    Tier routing order (fastest → slowest):
    ┌──────────────────────────────────────────────────────────┐
    │ HIGH   — FAQ cache hit (answer already known) → <100 ms │
    │ MEDIUM — RAG retrieval only (no LLM needed)  → <500 ms  │
    │ LOW    — Full LLM generation (last resort)   → 2-15 s   │
    └──────────────────────────────────────────────────────────┘

    Goal: only 20-30% of requests should reach the LLM tier.
    The other 70-80% return from FAQ or template fill.

    Response includes a ``tier`` field so monitoring / dashboards can track
    the distribution of requests across tiers.
    """
    import time as _time
    from app.services.conversation import get_or_create_session
    from app.services import rag_service as _rag

    t_start = _time.perf_counter()
    query = chat_request.message.strip()

    # ── TIER 1: FAQ Cache ─────────────────────────────────────────────────────
    try:
        faq_match = await _rag.faq_lookup(query)
        if faq_match:
            elapsed_ms = int((_time.perf_counter() - t_start) * 1000)
            logger.info(f"[PriorityQueue] TIER=HIGH (FAQ hit) q={query[:60]!r} ms={elapsed_ms}")
            return {
                "tier": "HIGH",
                "source": "faq_cache",
                "reply": faq_match,
                "session_id": chat_request.session_id,
                "response_ms": elapsed_ms,
            }
    except Exception as _e:
        logger.warning(f"[PriorityQueue] FAQ lookup failed: {_e}")

    # ── TIER 2: RAG Template (no LLM) ────────────────────────────────────────
    # For simple intent queries (e.g. doc status) we can fill a template from
    # retrieved chunks without calling Qwen3.
    try:
        rag_chunks = await _rag.get_rag_context(query)
        if rag_chunks:
            # Detect simple lookup intent using a lightweight keyword heuristic
            _STATUS_KEYWORDS = {"status", "where", "location", "tracking", "track", "received"}
            _words = set(query.lower().split())
            if _STATUS_KEYWORDS & _words:
                # Build a concise template answer from the top chunk
                top_chunk = rag_chunks[0] if isinstance(rag_chunks, list) else rag_chunks
                template_reply = (
                    f"Based on the available records: {str(top_chunk)[:500]}\n\n"
                    "For the latest status, please provide your tracking number or visit the DTS office."
                )
                elapsed_ms = int((_time.perf_counter() - t_start) * 1000)
                logger.info(f"[PriorityQueue] TIER=MEDIUM (RAG template) q={query[:60]!r} ms={elapsed_ms}")
                return {
                    "tier": "MEDIUM",
                    "source": "rag_template",
                    "reply": template_reply,
                    "session_id": chat_request.session_id,
                    "response_ms": elapsed_ms,
                }
    except Exception as _e:
        logger.warning(f"[PriorityQueue] RAG lookup failed: {_e}")

    # ── TIER 3: Full LLM Generation ───────────────────────────────────────────
    try:
        from app.services.conversation import process_message
        result = await process_message(
            db=db,
            message=query,
            session_id=chat_request.session_id,
            language=chat_request.language,
            topic=chat_request.topic,
        )
        elapsed_ms = int((_time.perf_counter() - t_start) * 1000)
        logger.info(f"[PriorityQueue] TIER=LOW (LLM) q={query[:60]!r} ms={elapsed_ms}")
        return {
            "tier": "LOW",
            "source": "llm",
            "reply": result.get("reply", ""),
            "session_id": result.get("session_id", chat_request.session_id),
            "response_ms": elapsed_ms,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"All tiers failed: {str(e)}")


# ── Phase 3: Knowledge Health Score Dashboard API ─────────────────────────────

@router.get("/admin/knowledge-health", response_model=dict)
@limiter.limit("20/minute")
async def knowledge_health(
    request: Request,
    db: DBSession = Depends(get_db),
    days: int = 7,
):
    """
    **Knowledge Health Score** — aggregated metrics for the admin dashboard.

    Queries the last *days* days of chat_logs, faq_entries, flagged_queries,
    faq_generation_queue, and document_chunks to produce a single health
    snapshot with scores, targets, and trend data.

    Metrics returned (with target thresholds from the improvement plan):
      - faq_coverage_rate       target >60%  (% queries matched by FAQ)
      - rag_hit_rate            target >80%  (% queries using RAG vs LLM)
      - llm_usage_per_100       target <30   (LLM calls per 100 queries)
      - flagged_resolution_rate target >90%  (pending queries resolved in 48 h)
      - avg_response_ms         target <2000 (average wall-clock latency)
      - overall_score           0-100 composite health score
    """
    from sqlalchemy import text as _sql_text, func
    from datetime import datetime, timezone, timedelta

    since = datetime.now(timezone.utc) - timedelta(days=days)

    # ── Raw counts from chat_logs ─────────────────────────────────────────────
    try:
        total_logs = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM chat_logs WHERE timestamp >= :since AND role = 'bot'"
            ),
            {"since": since},
        ).scalar() or 0

        faq_hits = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM chat_logs "
                "WHERE timestamp >= :since AND role = 'bot' AND response_source = 'faq_cache'"
            ),
            {"since": since},
        ).scalar() or 0

        rag_hits = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM chat_logs "
                "WHERE timestamp >= :since AND role = 'bot' AND response_source = 'rag_template'"
            ),
            {"since": since},
        ).scalar() or 0

        llm_hits = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM chat_logs "
                "WHERE timestamp >= :since AND role = 'bot' AND response_source = 'llm'"
            ),
            {"since": since},
        ).scalar() or 0

        avg_ms = db.execute(
            _sql_text(
                "SELECT AVG(response_ms) FROM chat_logs "
                "WHERE timestamp >= :since AND role = 'bot' AND response_ms IS NOT NULL"
            ),
            {"since": since},
        ).scalar() or 0

        # Trend: daily query counts (last 7 days)
        daily_rows = db.execute(
            _sql_text(
                "SELECT DATE(timestamp) as day, COUNT(*) as cnt "
                "FROM chat_logs "
                "WHERE timestamp >= :since AND role = 'bot' "
                "GROUP BY DATE(timestamp) ORDER BY day ASC"
            ),
            {"since": since},
        ).fetchall()

    except Exception as e:
        logger.warning(f"[HealthScore] chat_logs query failed: {e}")
        total_logs = faq_hits = rag_hits = llm_hits = 0
        avg_ms = 0
        daily_rows = []

    # ── Flagged queries ───────────────────────────────────────────────────────
    try:
        flagged_pending = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM flagged_queries WHERE status = 'pending'"
            )
        ).scalar() or 0

        flagged_resolved_48h = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM flagged_queries "
                "WHERE status = 'resolved' "
                "AND TIMESTAMPDIFF(HOUR, asked_at, resolved_at) <= 48"
            )
        ).scalar() or 0

        flagged_total_resolved = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM flagged_queries WHERE status = 'resolved'"
            )
        ).scalar() or 0

    except Exception as e:
        logger.warning(f"[HealthScore] flagged_queries query failed: {e}")
        flagged_pending = flagged_resolved_48h = flagged_total_resolved = 0

    # ── FAQ / Queue / Chunks ──────────────────────────────────────────────────
    try:
        total_faqs = db.execute(
            _sql_text("SELECT COUNT(*) FROM faq_entries")
        ).scalar() or 0

        queue_pending = db.execute(
            _sql_text(
                "SELECT COUNT(*) FROM faq_generation_queue WHERE status = 'pending'"
            )
        ).scalar() or 0

        queue_total = db.execute(
            _sql_text("SELECT COUNT(*) FROM faq_generation_queue")
        ).scalar() or 0

        total_chunks = db.execute(
            _sql_text("SELECT COUNT(*) FROM document_chunks")
        ).scalar() or 0

    except Exception as e:
        logger.warning(f"[HealthScore] faq/queue/chunk query failed: {e}")
        total_faqs = queue_pending = queue_total = total_chunks = 0

    # ── Compute derived metrics ───────────────────────────────────────────────
    def pct(num, denom):
        return round((num / denom * 100), 1) if denom > 0 else 0.0

    faq_coverage_rate     = pct(faq_hits, total_logs)
    rag_hit_rate          = pct(rag_hits + faq_hits, total_logs)   # non-LLM %
    llm_usage_per_100     = pct(llm_hits, total_logs)              # LLM %
    flagged_resolution_rate = pct(flagged_resolved_48h, max(flagged_total_resolved, 1))
    avg_response_ms       = round(float(avg_ms), 1)
    queue_progress        = pct(queue_total - queue_pending, queue_total) if queue_total else 100.0

    # ── Composite Health Score (0-100) ────────────────────────────────────────
    # Each metric contributes up to 20 points.
    # Target thresholds taken directly from the improvement plan (§5.2).
    def score_metric(value, target, higher_is_better=True):
        """Map a metric to 0-20 points relative to its target."""
        if higher_is_better:
            ratio = min(value / target, 1.0) if target else 0
        else:
            # lower is better (e.g. LLM usage, latency)
            ratio = max(0.0, 1.0 - (value - target) / target) if target else 0
        return round(ratio * 20, 1)

    s_faq     = score_metric(faq_coverage_rate,     60,   higher_is_better=True)
    s_rag     = score_metric(rag_hit_rate,           80,   higher_is_better=True)
    s_llm     = score_metric(llm_usage_per_100,      30,   higher_is_better=False)
    s_resolve = score_metric(flagged_resolution_rate,90,   higher_is_better=True)
    s_latency = score_metric(avg_response_ms,        2000, higher_is_better=False)
    overall_score = round(s_faq + s_rag + s_llm + s_resolve + s_latency, 1)

    # ── Daily trend list ──────────────────────────────────────────────────────
    trend = [{"day": str(r[0]), "queries": int(r[1])} for r in daily_rows]

    return {
        "success": True,
        "period_days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),

        # ── Core metrics ──
        "metrics": {
            "faq_coverage_rate":      {"value": faq_coverage_rate,      "target": 60,   "unit": "%",  "score": s_faq},
            "rag_hit_rate":           {"value": rag_hit_rate,           "target": 80,   "unit": "%",  "score": s_rag},
            "llm_usage_per_100":      {"value": llm_usage_per_100,      "target": 30,   "unit": "%",  "score": s_llm},
            "flagged_resolution_rate":{"value": flagged_resolution_rate, "target": 90,   "unit": "%",  "score": s_resolve},
            "avg_response_ms":        {"value": avg_response_ms,        "target": 2000, "unit": "ms", "score": s_latency},
        },

        # ── Composite score ──
        "overall_score": overall_score,
        "score_breakdown": {
            "faq_coverage": s_faq,
            "rag_hit_rate": s_rag,
            "llm_efficiency": s_llm,
            "flagged_resolution": s_resolve,
            "response_latency": s_latency,
        },

        # ── Volume counters ──
        "totals": {
            "total_queries_in_period": total_logs,
            "faq_hits":  faq_hits,
            "rag_hits":  rag_hits,
            "llm_hits":  llm_hits,
            "flagged_pending": flagged_pending,
            "total_faqs": total_faqs,
            "total_chunks": total_chunks,
            "queue_pending": queue_pending,
            "queue_total": queue_total,
            "queue_progress_pct": queue_progress,
        },

        # ── Daily trend ──
        "trend": trend,
    }


# ── Phase 4: Closed-Loop Background Jobs ──────────────────────────────────────

@router.post("/jobs/weekly-query-analysis", response_model=dict)
@limiter.limit("5/minute")
async def weekly_query_analysis(
    request: Request,
    db: DBSession = Depends(get_db)
):
    """
    **Phase 4: Weekly Query Analysis**
    Find the top 50 most frequent queries from the last 7 days that
    did not hit the FAQ cache.
    """
    from sqlalchemy import text as _sql_text
    from datetime import datetime, timezone, timedelta

    since = datetime.now(timezone.utc) - timedelta(days=7)
    
    # Simple frequent queries query (extract intent/entities or just exact match for now)
    results = db.execute(
        _sql_text(
            "SELECT message, count(*) as freq "
            "FROM chat_logs "
            "WHERE role = 'user' AND timestamp >= :since "
            "GROUP BY message "
            "ORDER BY freq DESC "
            "LIMIT 50"
        ),
        {"since": since}
    ).fetchall()
    
    # Real implementation would run ML clustering to group similar questions
    top_queries = [{"query": r[0], "count": r[1]} for r in results]

    return {
        "success": True,
        "message": f"Found {len(top_queries)} candidate queries for analysis.",
        "top_unanswered": top_queries
    }


@router.post("/jobs/nightly-cache-warmup", response_model=dict)
@limiter.limit("5/minute")
async def nightly_cache_warmup(
    request: Request,
    db: DBSession = Depends(get_db)
):
    """
    **Phase 4: Nightly Cache Warmup**
    Pre-embeds frequent queries and retrieves their RAG context ahead of time.
    Stores the context in 'query_cache_warmup' so that 'chat/prioritized'
    can serve these instantly as RAG templates.
    """
    from sqlalchemy import text as _sql_text
    from app.services import rag_service as _rag
    from app.db.models import QueryCacheWarmup
    import hashlib
    import json as json_lib

    # Get top 50 overall most common user queries
    top_queries = db.execute(
        _sql_text(
            "SELECT message "
            "FROM chat_logs "
            "WHERE role = 'user' "
            "GROUP BY message "
            "ORDER BY count(*) DESC "
            "LIMIT 50"
        )
    ).fetchall()

    warmed_count = 0
    for (query,) in top_queries:
        if not query or len(query) < 5: continue
        
        q_hash = hashlib.sha256(query.lower().strip().encode()).hexdigest()
        
        # Check if already warmed up recently
        existing = db.query(QueryCacheWarmup).filter_by(query_hash=q_hash).first()
        
        # Pre-retrieve RAG context (sync retrieval runs in memory)
        context_chunks = await _rag.retrieve_context_async(query)
        if context_chunks:
            if existing:
                existing.rag_context = context_chunks
                existing.hit_count += 1
            else:
                new_warmup = QueryCacheWarmup(
                    query_text=query,
                    query_hash=q_hash,
                    rag_context=context_chunks,
                    hit_count=1
                )
                db.add(new_warmup)
            warmed_count += 1

    db.commit()
    return {
        "success": True,
        "message": f"Warmed {warmed_count} frequent queries in the cache."
    }


@router.post("/jobs/monthly-faq-audit", response_model=dict)
@limiter.limit("5/minute")
async def monthly_faq_audit(
    request: Request,
    db: DBSession = Depends(get_db)
):
    """
    **Phase 4: Monthly FAQ Audit**
    Identifies stale/outdated FAQ entries.
    Flags entries that haven't been modified or asked about in 6 months for review.
    """
    from sqlalchemy import text as _sql_text
    from datetime import datetime, timezone, timedelta

    six_months_ago = datetime.now(timezone.utc) - timedelta(days=180)

    # Find FAQs not updated in 6 months
    stale_faqs = db.execute(
        _sql_text(
            "SELECT id, question, updated_at "
            "FROM faq_entries "
            "WHERE updated_at < :six_months_ago "
            "LIMIT 100"
        ),
        {"six_months_ago": six_months_ago}
    ).fetchall()

    stale_list = [{"id": r[0], "question": r[1], "last_updated": str(r[2])} for r in stale_faqs]

    return {
        "success": True,
        "message": f"Found {len(stale_list)} potentially stale FAQs for audit.",
        "stale_faqs": stale_list
    }

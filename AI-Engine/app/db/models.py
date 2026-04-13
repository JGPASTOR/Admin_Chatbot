"""SQLAlchemy ORM models for the DTS AI Engine database."""

from sqlalchemy import Column, Integer, String, Text, Float, DateTime, JSON, ForeignKey, Enum as SAEnum, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship
from datetime import datetime, timezone

Base = declarative_base()


class Session(Base):
    """Tracks conversation sessions for multi-turn context."""
    __tablename__ = "sessions"

    id = Column(String(36), primary_key=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    last_active = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)
    context = Column(JSON, default=dict, nullable=False)

    # Relationship
    chat_logs = relationship("ChatLog", back_populates="session", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Session(id={self.id})>"


class ChatLog(Base):
    """Stores every message exchanged in a conversation."""
    __tablename__ = "chat_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), ForeignKey("sessions.id"), nullable=False, index=True)
    role = Column(String(10), nullable=False)  # "user" or "bot"
    message = Column(Text, nullable=False)
    intent = Column(String(50), nullable=True)
    confidence = Column(Float, nullable=True)
    entities = Column(JSON, nullable=True)
    # Phase-1 observability columns
    response_source = Column(
        SAEnum('faq_cache', 'rag_template', 'llm', name='response_source_enum'),
        nullable=True,
    )  # which layer served the answer
    response_ms = Column(Integer, nullable=True)  # wall-clock response time in ms
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Author watermark — permanently stamps every log entry
    engine_author = Column(String(100), default="DTS AI Engine by Clarence Buenaflor, Jester Pastor & Mharjade Enario", nullable=False)
    engine_version = Column(String(20), default="1.0.0", nullable=False)

    # Relationship
    session = relationship("Session", back_populates="chat_logs")

    def __repr__(self):
        return f"<ChatLog(id={self.id}, role={self.role})>"


class TrainingData(Base):
    """Stores intent training examples. Used to retrain the classifier."""
    __tablename__ = "training_data"

    id = Column(Integer, primary_key=True, autoincrement=True)
    text = Column(Text, nullable=False)
    intent = Column(String(50), nullable=False, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f"<TrainingData(id={self.id}, intent={self.intent})>"


class FlaggedQuery(Base):
    """Questions the bot couldn't confidently answer — queued for admin review."""
    __tablename__ = "flagged_queries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    question = Column(Text, nullable=False)
    session_id = Column(String(36), nullable=True)
    confidence = Column(Float, default=0.0, nullable=False)
    topic = Column(String(20), nullable=True)
    # flag_type classifies WHY the query was flagged:
    #   low_confidence  — classifier was unsure (intent == unknown, conf ≥ 0.3)
    #   wrong_prompt    — very low confidence, likely off-topic / gibberish (conf < 0.3)
    #   missing_info    — valid intent but no RAG context and no FAQ match (knowledge gap)
    flag_type = Column(String(20), default="low_confidence", nullable=True)
    asked_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    status = Column(String(10), default="pending", nullable=False)  # pending | resolved | dismissed
    admin_answer = Column(Text, nullable=True)
    resolved_at = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<FlaggedQuery(id={self.id}, status={self.status})>"


class FAQEntry(Base):
    """Curated Q&A pairs. Checked before RAG — guarantees exact, correct answers."""
    __tablename__ = "faq_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    question = Column(Text, nullable=False)   # The canonical question (used for semantic matching)
    answer = Column(Text, nullable=False)     # The exact answer to return
    section = Column(String(100), nullable=True, index=True)  # Optional label e.g. "Section 3"
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f"<FAQEntry(id={self.id}, section={self.section})>"

    # Relationship
    history = relationship("FAQHistory", back_populates="faq", cascade="all, delete-orphan")


class DocumentChunk(Base):
    """
    Stores individual text chunks extracted from uploaded documents.

    Enables per-chunk operations: re-embed, delete, or re-run FAQ generation
    without reprocessing the entire parent document.
    """
    __tablename__ = "document_chunks"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    doc_id        = Column(Integer, nullable=False, index=True)          # references general_documents.id in adminDB
    doc_name      = Column(String(255), nullable=True)
    chunk_index   = Column(Integer, nullable=False)                       # order within document
    chunk_text    = Column(Text, nullable=False)
    section_label = Column(String(255), nullable=True, index=True)       # e.g. "Section 3 — Eligibility"
    page_number   = Column(Integer, nullable=True)
    char_count    = Column(Integer, nullable=True)
    created_at    = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    __table_args__ = (
        UniqueConstraint("doc_id", "chunk_index", name="uq_doc_chunk"),
    )

    def __repr__(self):
        return f"<DocumentChunk(doc_id={self.doc_id}, idx={self.chunk_index})>"


class FAQGenerationQueue(Base):
    """
    Queue table that drives background FAQ generation.

    After a document is ingested, one row per chunk is inserted here with
    status='pending'.  A background worker endpoint picks up batches of
    pending rows, calls Qwen3, and stores results in faq_entries.
    """
    __tablename__ = "faq_generation_queue"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    doc_id       = Column(Integer, nullable=False, index=True)
    doc_name     = Column(String(255), nullable=True)
    chunk_index  = Column(Integer, nullable=False)
    chunk_text   = Column(Text, nullable=False)
    section      = Column(String(255), nullable=True)
    status       = Column(
        SAEnum('pending', 'processing', 'done', 'failed', name='faq_queue_status_enum'),
        default='pending', nullable=False, index=True
    )
    retry_count  = Column(Integer, default=0, nullable=False)
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    processed_at = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<FAQGenerationQueue(doc_id={self.doc_id}, chunk={self.chunk_index}, status={self.status})>"


class FAQHistory(Base):
    """
    Immutable audit log for every mutation of an FAQ entry.

    Populated on create, edit, approve, reject, and delete so admins can
    roll back incorrect edits or review who approved what.
    """
    __tablename__ = "faq_history"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    faq_id      = Column(Integer, ForeignKey("faq_entries.id", ondelete="CASCADE"), nullable=False, index=True)
    question    = Column(Text, nullable=False)
    answer      = Column(Text, nullable=False)
    changed_by  = Column(String(100), nullable=True)   # e.g. 'admin', 'ai-auto', 'ai-judge'
    change_type = Column(
        SAEnum('created', 'edited', 'approved', 'rejected', 'deleted', name='faq_change_type_enum'),
        nullable=False
    )
    changed_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationship
    faq = relationship("FAQEntry", back_populates="history")

    def __repr__(self):
        return f"<FAQHistory(faq_id={self.faq_id}, type={self.change_type})>"


class QueryCacheWarmup(Base):
    """
    Stores pre-embedded common queries and their RAG context.
    Warmed up nightly, allowing instant RAG template responses for top queries.
    """
    __tablename__ = "query_cache_warmup"

    id = Column(Integer, primary_key=True, autoincrement=True)
    query_text = Column(Text, nullable=False)
    query_hash = Column(String(64), unique=True, nullable=False, index=True)
    rag_context = Column(JSON, nullable=True)
    hit_count = Column(Integer, default=0, nullable=False)
    last_refreshed = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f"<QueryCacheWarmup(query_hash={self.query_hash}, hits={self.hit_count})>"


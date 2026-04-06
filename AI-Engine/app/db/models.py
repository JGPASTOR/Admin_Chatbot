"""SQLAlchemy ORM models for the DTS AI Engine database."""

from sqlalchemy import Column, Integer, String, Text, Float, DateTime, JSON, ForeignKey
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

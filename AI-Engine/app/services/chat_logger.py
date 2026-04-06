"""Chat logger — persists messages to the database."""

from sqlalchemy.orm import Session as DBSession
from app.db.models import ChatLog
from typing import Optional
import json


def log_message(
    db: DBSession,
    session_id: str,
    role: str,
    message: str,
    intent: Optional[str] = None,
    confidence: Optional[float] = None,
    entities: Optional[dict] = None,
) -> ChatLog:
    """
    Save a chat message to the database.

    Args:
        db: Database session
        session_id: Conversation session ID
        role: "user" or "bot"
        message: The message text
        intent: Classified intent (for user messages)
        confidence: Classification confidence (for user messages)
        entities: Extracted entities (for user messages)

    Returns:
        The created ChatLog record
    """
    chat_log = ChatLog(
        session_id=session_id,
        role=role,
        message=message,
        intent=intent,
        confidence=confidence,
        entities=entities,
    )
    db.add(chat_log)
    db.commit()
    db.refresh(chat_log)
    return chat_log

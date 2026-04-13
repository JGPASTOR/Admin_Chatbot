"""Pydantic request/response schemas for the chat API."""

from pydantic import BaseModel, Field
from typing import Optional, Dict


class ChatRequest(BaseModel):
    """Request body for POST /ai/chat."""
    message: str = Field(..., min_length=1, max_length=1000, description="The user's message")
    session_id: Optional[str] = Field(None, description="Session ID for multi-turn conversation. Omit to start a new session.")
    language: str = Field(default="en", description="Language preference (e.g. 'en', 'tl')")
    topic: Optional[str] = Field(None, description="User's selected topic: 'docs' (Document Tracking) or 'lgu' (LGU Services). Enforces strict intent routing.")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "message": "What is the status of my document?",
                    "session_id": None,
                },
                {
                    "message": "PDID 001",
                    "session_id": "abc123-def456-ghi789",
                },
            ]
        }
    }


class ChatResponse(BaseModel):
    """Response body for POST /ai/chat."""
    reply: str = Field(..., description="The AI assistant's response")
    session_id: str = Field(..., description="Session ID (use this in the next request for multi-turn)")
    intent: str = Field(..., description="Classified intent of the user's message")
    confidence: float = Field(..., description="Confidence score of the classification")
    entities: Dict[str, str] = Field(default_factory=dict, description="Extracted entities (e.g., PDID)")
    author: str = Field(default="DTS AI Engine by Clarence Buenaflor, Jester Pastor and Mharjade Enario", description="Engine author watermark")
    engine_version: str = Field(default="1.0.0", description="Engine version")


class TrainRequest(BaseModel):
    """Request body for POST /ai/train."""
    source: str = Field(
        default="csv",
        description="Training source: 'csv' (from ml_data/intent_training.csv) or 'database' (from training_data table)"
    )


class TrainResponse(BaseModel):
    """Response body for POST /ai/train."""
    status: str
    num_samples: int
    num_intents: int
    intents: list
    training_accuracy: float


class HealthResponse(BaseModel):
    """Response body for GET /ai/health."""
    status: str
    model_loaded: bool
    model_intents: list


class TTSRequest(BaseModel):
    """Request body for POST /api/tts."""
    text: str = Field(..., min_length=1, max_length=5000, description="Text to convert to speech")
    voice: str = Field(
        default="en-US-GuyNeural",
        description="TTS voice. Options: 'en-US-GuyNeural' (English male, default), 'fil-PH-AngeloNeural' (Filipino male)"
    )
    auto_detect: bool = Field(
        default=True,
        description="When True (default), auto-detect language and pick the best voice. "
                    "Set to False when the user has explicitly chosen a voice to prevent overriding their choice."
    )


class RagIngestRequest(BaseModel):
    """Request body for POST /api/rag/ingest (and /api/rag/ingest-with-chunks)."""
    filename: str = Field(..., description="Original filename of the uploaded document")
    text: str = Field(..., min_length=1, description="Extracted plain text from the document")
    doc_id: Optional[int] = Field(
        None,
        description="(Phase-2) ID of the general_documents row in the Admin DB. "
                    "Required when calling /rag/ingest-with-chunks so chunks can be "
                    "linked back to the source document.",
    )



class RagIngestResponse(BaseModel):
    """Response body for POST /api/rag/ingest."""
    success: bool
    message: str
    chunks_added: int


class RagDeleteRequest(BaseModel):
    """Request body for POST /api/rag/delete."""
    filename: str = Field(..., description="Original filename of the document to delete")


class RagDeleteResponse(BaseModel):
    """Response body for POST /api/rag/delete."""
    success: bool
    message: str
    chunks_deleted: int


class RagRebuildResponse(BaseModel):
    """Response body for POST /api/rag/rebuild."""
    success: bool
    message: str
    total_chunks: int


class TopicSelectRequest(BaseModel):
    """Request body for POST /api/topic-select."""
    topic: str = Field(
        ...,
        description="The topic mode selected by the user: 'docs' (Document Tracking) or 'lgu' (General Services)"
    )
    session_id: Optional[str] = Field(None, description="Existing session ID to continue, or omit to start fresh")
    language: str = Field(default="en", description="Language preference for the welcome message (e.g. 'en', 'tl')")


class TopicSelectResponse(BaseModel):
    """Response body for POST /api/topic-select."""
    reply: str = Field(..., description="Welcome message for the selected topic")
    session_id: str = Field(..., description="Session ID to use for subsequent chat messages")
    topic: str = Field(..., description="The confirmed selected topic")


class FAQSuggestRequest(BaseModel):
    """Request body for POST /api/faq/suggest — generate FAQ proposals from document text."""
    text: str = Field(..., min_length=10, description="Extracted plain text from the document")
    filename: Optional[str] = Field(None, description="Document filename for labeling")


class FAQCreateRequest(BaseModel):
    """Request body for POST /api/faq — save a curated Q&A pair."""
    question: str = Field(..., min_length=5, description="The canonical question (used for semantic matching)")
    answer: str = Field(..., min_length=5, description="The exact answer the bot should return")
    section: Optional[str] = Field(None, description="Optional label, e.g. 'Section 3'")


class FAQUpdateRequest(BaseModel):
    """Request body for PUT /api/faq/{id} — update a curated Q&A pair."""
    question: Optional[str] = Field(None, min_length=5)
    answer: Optional[str] = Field(None, min_length=5)
    section: Optional[str] = None


class FAQResponse(BaseModel):
    """Single FAQ entry."""
    id: int
    question: str
    answer: str
    section: Optional[str]
    created_at: str
    updated_at: str


class FAQListResponse(BaseModel):
    """Response body for GET /api/faq."""
    success: bool
    total: int
    entries: list


class FAQDeleteResponse(BaseModel):
    """Response body for DELETE /api/faq/{id}."""
    success: bool
    message: str


class FlaggedQueryResolveRequest(BaseModel):
    """Request body for PATCH /api/flagged-queries/{id}/resolve."""
    answer: str = Field(..., min_length=5, description="The admin's answer to the flagged question")
    section: Optional[str] = Field(None, description="Optional FAQ section label")


class FlaggedQueryResponse(BaseModel):
    """Single flagged query entry."""
    id: int
    question: str
    session_id: Optional[str]
    confidence: float
    topic: Optional[str]
    flag_type: Optional[str]    # low_confidence | wrong_prompt | missing_info
    asked_at: str
    status: str
    admin_answer: Optional[str]
    resolved_at: Optional[str]

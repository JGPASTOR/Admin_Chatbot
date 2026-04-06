"""Integration tests for the chat API endpoint."""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Override settings before importing app
os.environ["DATABASE_URL"] = "sqlite:///./test_dts_ai.db"
os.environ["DTS_MOCK_MODE"] = "true"

from fastapi.testclient import TestClient
from app.main import app
from app.db.database import engine
from app.db.models import Base


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    """Create test database tables."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)
    engine.dispose()  # Release all connections before deleting file
    # Cleanup test db file
    try:
        if os.path.exists("./test_dts_ai.db"):
            os.remove("./test_dts_ai.db")
    except PermissionError:
        pass  # Windows may still hold the file briefly


@pytest.fixture
def client():
    """FastAPI test client."""
    with TestClient(app) as c:
        yield c


class TestHealthEndpoint:
    def test_health(self, client):
        response = client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "model_loaded" in data


class TestRootEndpoint:
    def test_root(self, client):
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "DTS AI Engine"


class TestChatEndpoint:
    def test_greeting(self, client):
        response = client.post("/api/chat", json={"message": "Hello"})
        assert response.status_code == 200
        data = response.json()
        assert "reply" in data
        assert "session_id" in data
        assert data["intent"] in ("greeting", "unknown")

    def test_document_status_no_pdid(self, client):
        """Asking about document status without PDID should prompt for PDID."""
        response = client.post("/api/chat", json={"message": "What is the status of my document?"})
        assert response.status_code == 200
        data = response.json()
        assert "PDID" in data["reply"] or "Tracking No" in data["reply"]
        assert data["session_id"] is not None

    def test_document_status_with_pdid(self, client):
        """Asking about a specific PDID should return document info."""
        response = client.post("/api/chat", json={"message": "Where is PDID 001?"})
        assert response.status_code == 200
        data = response.json()
        assert data["entities"].get("pdid") == "001"

    def test_multi_turn_conversation(self, client):
        """Test multi-turn: ask status → provide PDID."""
        # Turn 1: Ask about status (no PDID)
        r1 = client.post("/api/chat", json={"message": "What is the status of my document?"})
        assert r1.status_code == 200
        session_id = r1.json()["session_id"]

        # Turn 2: Provide PDID
        r2 = client.post("/api/chat", json={
            "message": "PDID 001",
            "session_id": session_id,
        })
        assert r2.status_code == 200
        data = r2.json()
        assert data["entities"].get("pdid") == "001"
        assert data["session_id"] == session_id

    def test_unknown_pdid(self, client):
        """Asking about a non-existent PDID should return not-found message."""
        response = client.post("/api/chat", json={"message": "Where is PDID 999?"})
        assert response.status_code == 200
        data = response.json()
        assert "couldn't find" in data["reply"].lower() or "not found" in data["reply"].lower() or "PDID" in data["reply"]

    def test_empty_message_rejected(self, client):
        """Empty message should be rejected by validation."""
        response = client.post("/api/chat", json={"message": ""})
        assert response.status_code == 422  # Validation error

    def test_help_intent(self, client):
        response = client.post("/api/chat", json={"message": "How do I use this system?"})
        assert response.status_code == 200
        data = response.json()
        assert "reply" in data

    def test_translation_tagalog(self, client):
        """Test if providing language='tagalog' translates the response."""
        # Note: Since the test runs offline/mocked, we just verify it doesn't crash 
        # and returns a reply. We can check if 'reply' exists.
        response = client.post("/api/chat", json={
            "message": "Hello", 
            "language": "tagalog"
        })
        assert response.status_code == 200
        data = response.json()
        assert "reply" in data
        assert data["intent"] in ("greeting", "unknown")


class TestTrainEndpoint:
    def test_train_from_csv(self, client):
        response = client.post("/api/train", json={"source": "csv"})
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["num_samples"] > 0
        assert data["training_accuracy"] > 0

    def test_train_invalid_source(self, client):
        response = client.post("/api/train", json={"source": "invalid"})
        assert response.status_code == 400

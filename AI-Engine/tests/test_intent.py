"""Tests for the intent classifier."""

import os
import sys
import pytest
import tempfile
import csv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.ml.intent_classifier import IntentClassifier
from app.ml.preprocessing import preprocess_text


class TestPreprocessing:
    """Tests for text preprocessing."""

    def test_lowercase(self):
        assert preprocess_text("HELLO WORLD") == "hello world"

    def test_whitespace_normalization(self):
        assert preprocess_text("  hello   world  ") == "hello world"

    def test_pdid_normalization(self):
        assert "pdid 001" in preprocess_text("PDID-001")
        assert "pdid 001" in preprocess_text("PDID001")
        assert "pdid 001" in preprocess_text("pdid 001")

    def test_empty_input(self):
        assert preprocess_text("") == ""
        assert preprocess_text("   ") == ""

    def test_preserves_question_mark(self):
        result = preprocess_text("Where is my document?")
        assert "?" in result


class TestIntentClassifier:
    """Tests for the intent classifier."""

    @pytest.fixture
    def training_csv(self, tmp_path):
        """Create a temporary training CSV."""
        csv_path = tmp_path / "training.csv"
        rows = [
            ("What is the status of my document?", "document_status"),
            ("Where is my document?", "document_status"),
            ("Check my document status", "document_status"),
            ("Track my document", "document_status"),
            ("Where is PDID 001?", "document_status"),
            ("Status of document", "document_status"),
            ("PDID 001", "follow_up"),
            ("PDID-002", "follow_up"),
            ("001", "follow_up"),
            ("My PDID is 003", "follow_up"),
            ("Here is the PDID 004", "follow_up"),
            ("It is PDID 005", "follow_up"),
            ("Hello", "greeting"),
            ("Hi there", "greeting"),
            ("Good morning", "greeting"),
            ("Hey", "greeting"),
            ("Greetings", "greeting"),
            ("Good afternoon", "greeting"),
            ("How do I use this?", "help"),
            ("What can you do?", "help"),
            ("Help me", "help"),
            ("Guide me", "help"),
            ("What are your features?", "help"),
            ("I need assistance", "help"),
            ("Tell me a joke", "unknown"),
            ("What is the weather?", "unknown"),
            ("Play music", "unknown"),
            ("Order food", "unknown"),
            ("Send an email", "unknown"),
            ("Calculate 2 plus 2", "unknown"),
        ]

        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["text", "intent"])
            writer.writerows(rows)

        return str(csv_path)

    def test_train_from_csv(self, training_csv):
        clf = IntentClassifier()
        stats = clf.train(csv_path=training_csv)

        assert stats["num_samples"] == 30
        assert stats["num_intents"] == 5
        assert stats["training_accuracy"] >= 0.7
        assert clf.is_loaded is True

    def test_train_from_data(self):
        clf = IntentClassifier()
        data = [
            ("Check my document", "document_status"),
            ("Where is it?", "document_status"),
            ("Hello", "greeting"),
            ("Hi", "greeting"),
        ]
        stats = clf.train(data=data)
        assert stats["num_samples"] == 4
        assert clf.is_loaded is True

    def test_predict_document_status(self, training_csv):
        clf = IntentClassifier()
        clf.train(csv_path=training_csv)

        intent, confidence = clf.predict("What is the status of my document?")
        assert intent == "document_status"
        assert confidence > 0.3

    def test_predict_greeting(self, training_csv):
        clf = IntentClassifier()
        clf.train(csv_path=training_csv)

        intent, confidence = clf.predict("Hello")
        assert intent == "greeting"
        assert confidence > 0.3

    def test_predict_without_model(self):
        clf = IntentClassifier()
        intent, confidence = clf.predict("Hello")
        assert intent == "unknown"
        assert confidence == 0.0

    def test_train_minimum_samples(self):
        clf = IntentClassifier()
        with pytest.raises(ValueError, match="at least 2"):
            clf.train(data=[("hello", "greeting")])

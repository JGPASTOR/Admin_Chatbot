"""Tests for entity extraction."""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.ml.entity_extractor import extract_entities


class TestEntityExtractor:
    """Tests for PDID entity extraction."""

    def test_pdid_with_space(self):
        result = extract_entities("PDID 001")
        assert result["pdid"] == "001"

    def test_pdid_with_hyphen(self):
        result = extract_entities("PDID-001")
        assert result["pdid"] == "001"

    def test_pdid_no_separator(self):
        result = extract_entities("PDID001")
        assert result["pdid"] == "001"

    def test_pdid_lowercase(self):
        result = extract_entities("pdid 001")
        assert result["pdid"] == "001"

    def test_pdid_in_sentence(self):
        result = extract_entities("What is the status of PDID 005?")
        assert result["pdid"] == "005"

    def test_pdid_with_underscore(self):
        result = extract_entities("PDID_010")
        assert result["pdid"] == "010"

    def test_standalone_number(self):
        """A standalone number should be extracted (likely a follow-up)."""
        result = extract_entities("001")
        assert result["pdid"] == "001"

    def test_standalone_number_no_padding(self):
        result = extract_entities("42")
        assert result["pdid"] == "042"

    def test_no_pdid(self):
        result = extract_entities("Hello, how are you?")
        assert result == {}

    def test_empty_input(self):
        result = extract_entities("")
        assert result == {}

    def test_none_input(self):
        result = extract_entities(None)
        assert result == {}

    def test_pdid_larger_number(self):
        result = extract_entities("PDID 12345")
        assert result["pdid"] == "12345"

    def test_my_pdid_is(self):
        result = extract_entities("My PDID is 007")
        assert result["pdid"] == "007"

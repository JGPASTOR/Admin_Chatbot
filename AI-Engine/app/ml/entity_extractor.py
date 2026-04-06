"""
Entity extractor for PDID (document tracking IDs).

Uses regex patterns to extract PDID numbers from user messages.
Supports formats: PDID 001, PDID-001, PDID001, pdid 001, etc.
"""

import re
from typing import Dict


# Patterns for extracting PDID numbers
PDID_PATTERNS = [
    # Explicit PDID prefix: "PDID 001", "PDID-001", "PDID001", "pdid 001"
    re.compile(r"(?i)\bpdid[\s\-_]*(\d{1,10})\b"),
    # PDID with connector words: "My PDID is 007", "PDID number 003"
    re.compile(r"(?i)\bpdid\s+(?:is|number|no\.?|num)\s+(\d{1,10})\b"),
    # Tracking number keywords (tightened to avoid false-matching dates/general numbers)
    re.compile(r"(?i)\b(?:document|tracking)\s*(?:no\.?|number|#)?\s*(\d{1,10})\b"),
    # Just a standalone number when in context of document tracking (fallback)
    # Only matches if the message is very short (likely a follow-up with just the number)
    re.compile(r"^\s*(\d{1,10})\s*$"),
]


def extract_entities(text: str) -> Dict[str, str]:
    """
    Extract entities from user text.

    Currently supports:
    - PDID: Document tracking ID

    Args:
        text: Raw user input

    Returns:
        Dict with extracted entities, e.g., {"pdid": "001"}
        Empty dict if no entities found.
    """
    entities = {}

    if not text or not text.strip():
        return entities

    # Try each pattern in order of specificity
    for pattern in PDID_PATTERNS:
        match = pattern.search(text)
        if match:
            pdid = match.group(1).strip().lstrip("0") or "0"
            # Pad to at least 3 digits for consistency
            pdid = pdid.zfill(3)
            entities["pdid"] = pdid
            break

    return entities

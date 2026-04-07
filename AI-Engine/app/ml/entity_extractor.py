"""
Entity extractor for PDID (document tracking IDs).

Uses regex patterns to extract PDID numbers from user messages.
Supports formats: PDID 001, PDID-001, PDID001, pdid 001, etc.
"""

import re
from typing import Dict


# Patterns for extracting PDID numbers (ordered most-to-least specific)
PDID_PATTERNS = [
    # Explicit PDID prefix: "PDID 001", "PDID-001", "PDID001", "pdid 001"
    re.compile(r"(?i)\bpdid[\s\-_]*(\d{1,10})\b"),
    # PDID with connector words: "My PDID is 007", "PDID number 003"
    re.compile(r"(?i)\bpdid\s+(?:is|number|no\.?|num)\s+(\d{1,10})\b"),
    # Tracking / document number keywords: "tracking number is 1005", "document no. 1002"
    re.compile(r"(?i)\b(?:tracking|document|doc)\s*(?:no\.?|number|#|id)?\s*(?:is|=|:)?\s*(\d{3,10})\b"),
    # "status of 1003", "check 1002", "where is 1005", "track my 1004"
    re.compile(r"(?i)\b(?:status|check|track|locate|find|where|update)\s+(?:of|for|is|on|my|document|doc)?\s*(?:pdid)?\s*(\d{3,10})\b"),
    # "my document 1001", "document number 1002", "doc 1003"
    re.compile(r"(?i)\b(?:my\s+)?(?:document|doc)\s*(?:no\.?|number|#|id)?\s*(\d{3,10})\b"),
    # "number 1001", "no. 1002", "#1003"
    re.compile(r"(?i)\b(?:number|no\.?|#)\s*(\d{3,10})\b"),
    # Just a standalone number (short message — likely a follow-up reply with just the PDID)
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

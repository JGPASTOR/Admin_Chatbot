"""Text preprocessing for the ML pipeline."""

import re
import string


# Common English stopwords that add noise to TF-IDF (kept small to avoid over-filtering)
STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "am", "i", "me", "my",
    "we", "our", "you", "your", "it", "its", "this", "that", "these",
    "those", "of", "in", "to", "for", "with", "on", "at", "from", "by",
    "as", "into", "about", "just", "so", "very", "really", "also",
}

# Common Filipino stopwords
FILIPINO_STOPWORDS = {
    "ang", "ng", "sa", "na", "nang", "ay", "mga", "si", "ni", "kay",
    "at", "o", "din", "rin", "pa", "lang", "lamang", "naman", "ba",
    "daw", "raw", "kasi", "dahil", "pero", "subalit", "kung",
}


def preprocess_text(text: str) -> str:
    """
    Normalize input text for intent classification.

    Steps:
    1. Lowercase
    2. Normalize whitespace
    3. Preserve PDID patterns (e.g., PDID-001, PDID 001)
    4. Remove excessive punctuation but keep basic structure
    5. Remove stopwords to reduce TF-IDF noise
    """
    if not text or not text.strip():
        return ""

    # Lowercase
    text = text.lower().strip()

    # Normalize whitespace (multiple spaces/tabs to single space)
    text = re.sub(r"\s+", " ", text)

    # Normalize PDID patterns to a consistent format: "pdid 001"
    # Matches: PDID-001, PDID 001, PDID001, pdid-001, etc.
    text = re.sub(r"pdid[\s\-_]*(\d+)", r"pdid \1", text)

    # Remove punctuation except hyphens, question marks, and exclamation marks
    # (question marks help distinguish questions; exclamation marks help detect complaints)
    allowed = set(string.ascii_lowercase + string.digits + " -?!")
    # Keep Filipino characters (ñ, accented vowels)
    filipino_chars = set("ñáàâéèêíìîóòôúùû")
    allowed = allowed | filipino_chars
    text = "".join(ch if ch in allowed else " " for ch in text)

    # Remove stopwords
    words = text.split()
    words = [w for w in words if w not in STOPWORDS and w not in FILIPINO_STOPWORDS]

    # Final whitespace cleanup
    text = " ".join(words).strip()

    return text

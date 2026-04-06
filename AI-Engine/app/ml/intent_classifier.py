"""
Trainable intent classifier using TF-IDF + SGDClassifier.

Supports:
- Training from CSV file or list of (text, intent) tuples
- Prediction with confidence scores
- Model save/load via joblib
- Retraining at runtime
"""

import os
import csv
import threading
import numpy as np
from collections import Counter
from typing import Tuple, List, Optional
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
import joblib

from app.ml.preprocessing import preprocess_text
from app.config import settings


class IntentClassifier:
    """ML-based intent classifier with TF-IDF + SGDClassifier pipeline."""

    def __init__(self):
        self.pipeline: Optional[Pipeline] = None
        self.model_path = os.path.join(settings.MODEL_DIR, "intent_model.joblib")
        self.is_loaded = False
        self._lock = threading.Lock()

    def train(self, csv_path: str = None, data: List[Tuple[str, str]] = None) -> dict:
        """
        Train the intent classifier.

        Args:
            csv_path: Path to CSV with columns 'text' and 'intent'
            data: List of (text, intent) tuples as alternative input

        Returns:
            Dict with training stats (num_samples, num_intents, accuracy)
        """
        texts = []
        intents = []

        if csv_path:
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                required = {"text", "intent"}
                fieldnames = reader.fieldnames or []
                if required.issubset(fieldnames):
                    for row in reader:
                        text = row.get("text")
                        intent = row.get("intent")
                        if text is None or intent is None:
                            continue
                        processed = preprocess_text(text)
                        if processed:
                            texts.append(processed)
                            intents.append(str(intent).strip())
                else:
                    raise ValueError(
                        f"CSV must have columns 'text' and 'intent'. Found: {fieldnames}"
                    )

        if data:
            for text, intent in data:
                processed = preprocess_text(text)
                if processed:
                    texts.append(processed)
                    intents.append(intent.strip())

        if len(texts) < 2:
            raise ValueError("Need at least 2 training samples")

        # Ensure every class has at least 2 samples (required for train/val split)
        class_counts = Counter(intents)
        rare = [cls for cls, count in class_counts.items() if count < 2]
        if rare:
            raise ValueError(
                f"Each intent class needs at least 2 samples. Under-represented: {rare}"
            )

        # Build pipeline: TF-IDF → SGDClassifier (modified_huber supports predict_proba)
        base_clf = SGDClassifier(
            loss="modified_huber",
            max_iter=1000,
            tol=1e-3,
            random_state=42,
            class_weight="balanced",
        )

        new_pipeline = Pipeline([
            ("tfidf", TfidfVectorizer(
                ngram_range=(1, 2),
                max_features=5000,
                sublinear_tf=True,
            )),
            ("clf", base_clf),
        ])

        new_pipeline.fit(texts, intents)

        # Calculate accuracy on a held-out validation split for an honest estimate
        X_train, X_val, y_train, y_val = train_test_split(
            texts, intents, test_size=0.2, random_state=42, stratify=intents
        )
        val_pipeline = Pipeline([
            ("tfidf", TfidfVectorizer(
                ngram_range=(1, 2),
                max_features=5000,
                sublinear_tf=True,
            )),
            ("clf", SGDClassifier(
                loss="modified_huber",
                max_iter=1000,
                tol=1e-3,
                random_state=42,
                class_weight="balanced",
            )),
        ])
        val_pipeline.fit(X_train, y_train)
        val_predictions = val_pipeline.predict(X_val)
        accuracy = np.mean([p == t for p, t in zip(val_predictions, y_val)])

        # Save model
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump(new_pipeline, self.model_path)

        # Atomically swap the pipeline (prevents race with predict)
        with self._lock:
            self.pipeline = new_pipeline
            self.is_loaded = True

        unique_intents = list(set(intents))

        return {
            "num_samples": len(texts),
            "num_intents": len(unique_intents),
            "intents": unique_intents,
            "training_accuracy": round(float(accuracy), 4),
        }

    def load(self) -> bool:
        """Load a previously trained model. Returns True if successful."""
        if os.path.exists(self.model_path):
            loaded = joblib.load(self.model_path)
            with self._lock:
                self.pipeline = loaded
                self.is_loaded = True
            return True
        return False

    def predict(self, text: str) -> Tuple[str, float]:
        """
        Predict intent for the given text.

        Args:
            text: Raw user input

        Returns:
            Tuple of (intent_label, confidence_score)
            Returns ("unknown", 0.0) if model is not loaded or confidence is too low
        """
        with self._lock:
            if not self.is_loaded or self.pipeline is None:
                return ("unknown", 0.0)
            pipeline = self.pipeline

        processed = preprocess_text(text)
        if not processed:
            return ("unknown", 0.0)

        # Get prediction with probabilities
        intent = pipeline.predict([processed])[0]
        probabilities = pipeline.predict_proba([processed])[0]
        confidence = float(max(probabilities))

        # If confidence is below threshold, return unknown
        if confidence < settings.CONFIDENCE_THRESHOLD:
            return ("unknown", confidence)

        return (intent, confidence)

    @property
    def classes(self) -> list:
        """Return the list of known intent classes."""
        with self._lock:
            if self.pipeline is not None:
                return list(self.pipeline.named_steps["clf"].classes_)
        return []

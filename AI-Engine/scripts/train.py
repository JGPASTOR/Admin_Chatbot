"""CLI script to train the intent classifier."""

import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.ml.intent_classifier import IntentClassifier
from app.config import settings


def main():
    csv_path = os.path.join(settings.TRAINING_DATA_DIR, "intent_training.csv")

    if not os.path.exists(csv_path):
        print(f"ERROR: Training data not found at {csv_path}")
        sys.exit(1)

    print(f"Training intent classifier from: {csv_path}")
    print("-" * 50)

    classifier = IntentClassifier()
    stats = classifier.train(csv_path=csv_path)

    print(f"Training complete!")
    print(f"  Samples:  {stats['num_samples']}")
    print(f"  Intents:  {stats['num_intents']} ({', '.join(stats['intents'])})")
    print(f"  Accuracy: {stats['training_accuracy'] * 100:.1f}%")
    print(f"  Model saved to: {classifier.model_path}")
    print("-" * 50)

    # Quick test
    test_inputs = [
        "What is the status of my document?",
        "PDID 001",
        "Hello",
        "How do I use this?",
        "Tell me a joke",
    ]

    print("\nQuick test predictions:")
    for text in test_inputs:
        intent, confidence = classifier.predict(text)
        print(f"  '{text}' → {intent} ({confidence:.2f})")


if __name__ == "__main__":
    main()

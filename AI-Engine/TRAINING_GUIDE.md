# 🧠 AI Training Guide — DTS Document Tracking System

This guide explains how to teach the AI to understand new types of user messages.

---

## How It Works (Quick Overview)

```
1. You add example sentences  →  ml_data/intent_training.csv
2. You run the training script →  python scripts/train.py
3. The AI saves its "brain"    →  ml_models/intent_model.joblib
4. Restart the server          →  AI now uses the updated model
```

---

## Step 1: Add Training Examples

Open `ml_data/intent_training.csv` and add new rows.

### Format

```csv
text,intent
```

- **text** = An example sentence a user might type
- **intent** = The category label for that sentence

### Current Intent Categories

| Intent            | Meaning                        | Example                              |
| ----------------- | ------------------------------ | ------------------------------------ |
| `document_status` | User asks about a document     | "What is the status of my document?" |
| `follow_up`       | User provides a PDID number    | "PDID 001"                           |
| `greeting`        | User says hello                | "Hello", "Good morning"              |
| `help`            | User asks how the system works | "How do I use this?"                 |
| `unknown`         | Off-topic messages             | "Tell me a joke"                     |

### Adding More Examples for an Existing Intent

Just add new rows with one of the labels above. Example:

```csv
Can you find my document?,document_status
Where did my paper go?,document_status
I need to locate my file,document_status
```

### Adding a Brand New Intent

To create a new intent category (e.g., `complaint`):

1. Add **at least 5–10 rows** with the new label:

```csv
I want to file a complaint,complaint
This is taking too long,complaint
I'm not happy with the service,complaint
My document has been pending for weeks,complaint
I want to report a problem,complaint
```

2. **Also update the response file** — see Step 3 below.

> ⚠️ **Important:** Add varied phrasing. The more diverse your examples, the better the AI understands.

---

## Step 2: Train the AI

Open a terminal in the project root folder and run:

```bash
python scripts/train.py
```

### Expected Output

```
Training intent classifier from: .../ml_data/intent_training.csv
--------------------------------------------------
Training complete!
  Samples:  64
  Intents:  5 (document_status, follow_up, greeting, help, unknown)
  Accuracy: 100.0%
  Model saved to: .../ml_models/intent_model.joblib
--------------------------------------------------

Quick test predictions:
  'What is the status of my document?' → document_status (0.98)
  'PDID 001' → follow_up (0.85)
  'Hello' → greeting (0.95)
```

✅ Check that **Accuracy** is high (ideally 90%+) and the test predictions look correct.

---

## Step 3: Add a Response (Only for NEW Intents)

> **Skip this step** if you only added more examples for existing intents.

If you added a new intent label (e.g., `complaint`), open `app/services/response_generator.py` and add a new block **before** the `# --- Unknown / fallback ---` section:

```python
    # --- Complaint ---
    if intent == "complaint":
        return (
            "I'm sorry to hear you're having trouble. "
            "Please visit the DTS office or contact support "
            "for assistance with your concern."
        )
```

---

## Step 4: Restart the Server

If the server is running with `--reload`, save any `.py` file to trigger a restart. Otherwise:

```bash
# Stop the server (Ctrl+C), then start it again:
uvicorn app.main:app --reload
```

---

## Step 5: Verify the AI Learned

### Option A: Check the Training Output

Look at the accuracy and test predictions printed by `train.py` in Step 2.

### Option B: Test via Chat API

Send a test message using curl or a browser:

```bash
curl -X POST http://localhost:8000/api/chat -H "Content-Type: application/json" -d "{\"message\": \"your test sentence here\"}"
```

Check that the `intent` and `confidence` fields in the response match what you expect.

### Option C: Quick Python Test

```bash
python -c "from app.ml.intent_classifier import IntentClassifier; c = IntentClassifier(); c.load(); print(c.predict('your test sentence here'))"
```

Output example: `('document_status', 0.95)` means the AI classified it as `document_status` with 95% confidence.

---

## Quick Reference

| Task                 | Action                                                              |
| -------------------- | ------------------------------------------------------------------- |
| Teach AI new phrases | Add rows to `ml_data/intent_training.csv`                           |
| Train the model      | Run `python scripts/train.py`                                       |
| Add a new category   | Add CSV rows + add response in `app/services/response_generator.py` |
| Verify it worked     | Check training output or test via API                               |
| Model location       | `ml_models/intent_model.joblib`                                     |
| Confidence threshold | `app/config.py` → `CONFIDENCE_THRESHOLD` (default: 0.4)             |

---

## Troubleshooting

| Problem                                  | Solution                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| Training accuracy is low                 | Add more diverse examples (aim for 10+ per intent)                             |
| AI returns `unknown` for valid questions | Lower `CONFIDENCE_THRESHOLD` in `app/config.py`, or add more training examples |
| "Training data not found" error          | Make sure you're running the command from the project root folder              |
| New intent not getting a response        | Make sure you added a response block in `response_generator.py`                |

---

## File Map

| File                                 | What It Does                                       |
| ------------------------------------ | -------------------------------------------------- |
| `ml_data/intent_training.csv`        | Training data — **edit this**                      |
| `scripts/train.py`                   | Training script — **run this**                     |
| `ml_models/intent_model.joblib`      | Saved model (auto-generated)                       |
| `app/services/response_generator.py` | Response templates — edit for **new intents only** |
| `app/config.py`                      | Settings (confidence threshold, paths)             |

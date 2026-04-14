# DTS Chatbot — System Guide

**Why "Needs Review" exists, what "Health Score" measures, and what was fixed.**

---

## 1. Why Do We Need "Needs Review"?

### The Problem It Solves

The bot cannot know the answer to *everything*. When a citizen asks a question the bot has never seen before — or asks it in an unusual way — one of three things happens:

| Situation | Flag Type | Meaning |
|-----------|-----------|---------|
| Bot is very unsure (confidence < 30%) | `wrong_prompt` | Likely gibberish or totally off-topic |
| Bot has a guess but isn't confident (confidence 30–60%) | `low_confidence` | Valid question, shaky answer |
| Bot understood the question but your knowledge base has **no information** | `missing_info` | Real gap in your documents |

Without "Needs Review", those questions would just get a bad answer or a generic "I don't know" — and nobody would ever fix it. The loop would never close.

### The Closed-Loop Flow

```
Citizen asks question
       │
       ▼
Bot can't answer confidently
       │
       ▼
Question saved to "Needs Review" (pending)
       │
       ▼
Admin writes the correct answer  ←── YOU DO THIS
       │
       ▼
Answer saved as a new FAQ entry
       │
       ▼
FAQ loaded into bot memory immediately (ChromaDB cache)
       │
       ▼
Next citizen asks the same question → bot answers instantly
```

**In short:** every question the bot fails on today becomes training material that makes it smarter tomorrow. The admin is the teacher; "Needs Review" is the homework pile.

### The Three Flag Types Explained

- **`wrong_prompt`** — The message was probably not meant for this bot (typos, random text, other languages). You can **Dismiss** these — no need to teach the bot to answer gibberish.
- **`low_confidence`** — The bot *tried* to answer but wasn't sure. Review these — if the bot's attempt was correct, you can still add it as a FAQ. If it was wrong, write the right answer.
- **`missing_info`** — The bot understood the question perfectly but your documents have *no information* about it. This is the most valuable flag: it tells you exactly what citizens are asking that you haven't documented yet. **Always resolve these.**

---

## 2. What Is the Knowledge Health Score?

### Why It Matters

The Health Score is a single number (0–100) that tells you **how well your knowledge base is serving citizens right now**. Without it, you'd have to dig through logs to figure out why the bot is giving bad answers. The score gives you an instant diagnosis.

### How the Score Is Calculated

Five metrics, each scored out of 20 points = 100 total:

| Metric | Target | What It Measures |
|--------|--------|-----------------|
| **FAQ Coverage Rate** | > 60% | % of questions answered from your curated FAQ list (fastest, most accurate path) |
| **RAG Hit Rate** | > 80% | % of questions where relevant document context was found |
| **LLM Dependency** | < 30% | % of questions that needed the AI to generate an answer (slowest, least reliable) |
| **Flagged Resolution Rate** | > 90% | % of "Needs Review" questions resolved within 48 hours |
| **Avg Response Time** | < 2000ms | How fast the bot replies on average |

### Grade Scale

| Score | Grade | What It Means |
|-------|-------|---------------|
| 90–100 | A+ | Excellent — bot is fast, accurate, well-maintained |
| 80–89 | A | Good — minor gaps, keep monitoring |
| 70–79 | B | Acceptable — some knowledge gaps to address |
| 55–69 | C | Below average — review flagged queries and add more FAQs |
| 40–54 | D | Poor — significant gaps, urgent action needed |
| < 40 | F | Critical — bot is largely failing citizens |

### How to Improve the Score

- **Low FAQ Coverage** → Go to AI Training, approve pending FAQ proposals, or manually add FAQs for common questions.
- **Low RAG Hit Rate** → Upload more relevant documents so the bot has more context to draw from.
- **High LLM Dependency** → The bot is guessing too much. Approve more FAQs so it stops using the AI for common questions.
- **Low Flagged Resolution Rate** → Check "Needs Review" more often. Unresolved flags drag this score down.
- **Slow Response Time** → Usually means the LLM is being hit too often. See "High LLM Dependency" above.

---

## 3. Bugs Fixed in This Update

### Bug 1 — "Resolve & Add to Bot" Timed Out (Needs Review Page)

**What happened:** When admin clicked "Resolve & Add to Bot", an error toast appeared even though the answer was actually saved to the database. The bot just didn't have it in memory yet.

**Root cause:** The resolve endpoint was synchronously waiting for the embedding service to process the question (add it to ChromaDB vector memory). The embedding service can take 10–30 seconds to respond, especially when warming up. The proxy had an 8-second timeout, so it gave up early and reported "Network error".

**Fix applied:**
- The FAQ cache update (ChromaDB) now runs as a **background task** — the API returns success immediately after saving to the database, then loads into memory in the background.
- Proxy timeout increased from **8 seconds → 30 seconds** as a safety net.

### Bug 2 — Approving AI-Generated FAQs Didn't Always Reach Bot Memory

**What happened:** Approving pending FAQ proposals from the AI Training page saved them to MySQL but they didn't always show up in the bot's live memory immediately.

**Root cause:** The push to the AI Engine's in-memory cache had a 5-second timeout — not enough when the embedding service is under load. The error was silently caught, so the UI showed "approved" but the bot didn't know about it until the next restart.

**Fix applied:**
- Timeout for the cache-push call increased from **5 seconds → 20 seconds** for both single and bulk approvals.
- The `POST /api/faq` endpoint now also returns `success: true` (not false) for duplicate entries, since the duplicate is still being cached — this prevents false error signals to the admin panel.

### Bug 3 — Mobile Devices Got CORS Errors

**What happened:** Mobile phones and other devices on the local network (accessing the server at `192.168.160.118`) could not reach the AI Engine because the CORS policy only allowed `localhost`.

**Fix applied:**
- Added `http://192.168.160.118`, `http://192.168.160.118:3005`, and `http://192.168.160.118:8000` to the `CORS_ORIGINS` environment variable in `docker-compose.yml`.

> **Note for the team:** If you change the server IP, update `CORS_ORIGINS` in `docker-compose.yml` to match.

---

## 4. The "Mobile Goes to Pending" Behavior — This Is Normal

When a citizen on mobile asks a question and the bot can't answer confidently, the question is automatically saved to "Needs Review". **This is by design.** It is not a bug.

The flow is:
1. Citizen types a question the bot doesn't know
2. Bot returns a helpful fallback message ("I'm not sure, but here's what I can tell you…")
3. The question is silently flagged in the background
4. Admin sees it in "Needs Review" → resolves it → bot learns

The citizen always gets *a* response. The admin gets a queue of gaps to fill. This is the closed-loop learning system working as intended.

If you want **fewer questions going to pending**, the solution is to build up your FAQ library (AI Training Hub → approve proposals, upload more documents).

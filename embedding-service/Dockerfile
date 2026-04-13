FROM python:3.11-slim

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the model during build so container starts instantly
ARG EMBEDDING_MODEL=all-MiniLM-L6-v2
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBEDDING_MODEL}')"

# Application code
COPY main.py .

ENV EMBEDDING_MODEL=${EMBEDDING_MODEL}
ENV HOST=0.0.0.0
ENV PORT=8002

EXPOSE 8002

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002", "--workers", "1", "--log-level", "info"]

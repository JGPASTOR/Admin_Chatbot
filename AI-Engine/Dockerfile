# ── AI Engine — FastAPI / Python 3.11 ────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Install OS deps needed by some Python packages (e.g. sentence-transformers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer-cached unless requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Create directories that are bind-mounted as volumes
# (volumes will override these on container start, but they must exist for the image)
RUN mkdir -p ml_models ml_data

EXPOSE 8000

# Run with 2 workers in production; remove --reload
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

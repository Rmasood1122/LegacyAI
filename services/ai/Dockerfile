# LegacyAI AI service (Phase 2). Small, non-root, no secrets baked in.
#   docker build -t legacyai-ai services/ai
# The redaction model (spaCy en_core_web_sm, a pinned wheel) and the embedding model
# (bge-small-en-v1.5) are inside the image: nothing is downloaded when the service runs.

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FASTEMBED_CACHE_PATH=/app/models
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')" \
 && chmod -R a+rX /app/models
# From here on the model hub is never contacted.
ENV HF_HUB_OFFLINE=1
COPY app ./app
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

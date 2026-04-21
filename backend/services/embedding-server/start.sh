#!/usr/bin/env bash
# Convenience launcher for the BGE-M3 embedding service.
#
# Env overrides:
#   EMBED_PORT (default 18080)
#   EMBED_MODEL_PATH (default ./models/bge-m3)
#   EMBED_MAX_SEQ_LEN (default 8192)
#   EMBED_BATCH_SIZE (default 8)
#   EMBED_NUM_THREADS (default 0 == torch default)
#   EMBED_HOST (default 127.0.0.1)
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  echo "venv missing — run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

if [[ ! -d "${EMBED_MODEL_PATH:-./models/bge-m3}" ]]; then
  echo "model dir missing — run: .venv/bin/python download_model.py" >&2
  exit 1
fi

PORT="${EMBED_PORT:-18080}"
HOST="${EMBED_HOST:-127.0.0.1}"

exec .venv/bin/uvicorn server:app \
  --host "$HOST" \
  --port "$PORT" \
  --log-level info \
  --workers 1

#!/usr/bin/env bash
# Convenience launcher for the BGE-M3 embedding service.
#
# Env overrides:
#   EMBED_PORT         默认 18080
#   EMBED_HOST         默认 127.0.0.1
#   EMBED_MODEL_PATH   默认 ./models/bge-m3
#   EMBED_BACKEND      torch (默认) / onnx
#   EMBED_MAX_SEQ_LEN  默认 8192；截到 4096/2048 能显著加速长文
#   EMBED_BATCH_SIZE   默认 8
#   EMBED_NUM_THREADS  默认 0 (torch default)；一台 56-core 机器上 ×workers 不超过总核数
#   EMBED_WORKERS      uvicorn worker 数，默认 1。每 worker 独立加载模型（~2.3GB 内存）。
#                      多 worker 下 backfill 客户端可以用 --concurrency N 并行发
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
WORKERS="${EMBED_WORKERS:-1}"

exec .venv/bin/uvicorn server:app \
  --host "$HOST" \
  --port "$PORT" \
  --log-level info \
  --workers "$WORKERS"

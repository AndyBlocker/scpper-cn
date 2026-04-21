"""Minimal CPU BGE-M3 HTTP service, TEI-compatible subset.

Endpoints:
- `GET  /health` — liveness probe returning `{"status": "ok", "model": ...}`
- `POST /embed`  — body `{"inputs": ["..."], "normalize": true}` → `[[float, ...], ...]`

Designed to be a drop-in replacement for the `/embed` path of
`ghcr.io/huggingface/text-embeddings-inference` so the Node caller can
later switch to TEI without code changes.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# `sentence-transformers` pulls torch; both need to be installed in the venv.
from sentence_transformers import SentenceTransformer  # type: ignore
import torch


# ── Configuration (env overrides supported) ─────────────────────────
MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
MODEL_PATH = os.environ.get(
    "EMBED_MODEL_PATH",
    str(Path(__file__).parent / "models" / "bge-m3"),
)
MAX_SEQ_LEN = int(os.environ.get("EMBED_MAX_SEQ_LEN", "8192"))
DEFAULT_BATCH_SIZE = int(os.environ.get("EMBED_BATCH_SIZE", "8"))
NUM_THREADS = int(os.environ.get("EMBED_NUM_THREADS", "0"))  # 0 == leave default
# "onnx" | "torch"；BGE-M3 自带 ONNX 权重 (onnx/model.onnx + model.onnx_data)，
# CPU 上 ONNX Runtime 一般比 PyTorch 快 2-3x
BACKEND = os.environ.get("EMBED_BACKEND", "torch").lower()

if NUM_THREADS > 0:
    torch.set_num_threads(NUM_THREADS)


# ── Model load ───────────────────────────────────────────────────────
print(f"Loading model from {MODEL_PATH} (name={MODEL_NAME}, backend={BACKEND}) …", flush=True)
if BACKEND == "onnx":
    # sentence-transformers 5.x 支持 backend='onnx'；会从 `onnx/` 子目录挑 ONNX file
    model = SentenceTransformer(
        MODEL_PATH,
        device="cpu",
        backend="onnx",
        trust_remote_code=True,
        model_kwargs={"file_name": "onnx/model.onnx", "provider": "CPUExecutionProvider"},
    )
else:
    model = SentenceTransformer(
        MODEL_PATH,
        device="cpu",
        trust_remote_code=True,
    )
# BGE-M3 默认上限是 8192；如果模型没显式设，这里设死，避免 tokenizer 意外截短。
try:
    model.max_seq_length = MAX_SEQ_LEN
except AttributeError:
    pass

# 拿实际 embedding dim（BGE-M3 = 1024）；dim mismatch 时 CLI 侧能直接看出
DIM = int(model.get_sentence_embedding_dimension())
print(f"Model ready. dim={DIM}, max_seq={MAX_SEQ_LEN}, threads={torch.get_num_threads()}", flush=True)


# ── HTTP app ─────────────────────────────────────────────────────────
app = FastAPI(title="scpper-embedding", version="1.0.0")


class EmbedRequest(BaseModel):
    inputs: List[str] = Field(default_factory=list)
    normalize: bool = True
    batch_size: int | None = None


class EmbedResponseItem(BaseModel):
    # TEI 返回纯 nested list；为了兼容，我们也直接返回 list[list[float]]，
    # 但同时在 `/embed/with-meta` 下提供结构化返回。
    pass


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "dim": DIM, "max_seq_len": MAX_SEQ_LEN}


@app.post("/embed")
def embed(req: EmbedRequest):
    if not req.inputs:
        return []
    if len(req.inputs) > 256:
        raise HTTPException(status_code=400, detail="too many inputs per request (max 256)")
    batch = req.batch_size or DEFAULT_BATCH_SIZE
    try:
        vectors = model.encode(
            req.inputs,
            batch_size=batch,
            normalize_embeddings=req.normalize,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"encode failed: {exc}") from exc
    # numpy ndarray → list
    return vectors.tolist()

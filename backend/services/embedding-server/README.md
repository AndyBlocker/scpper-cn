# scpper-embedding (BGE-M3 local)

CPU-only BGE-M3 embedding server. Drop-in replacement for the `/embed` path of
`ghcr.io/huggingface/text-embeddings-inference` so the Node backend can later
switch to TEI without changes.

## One-time setup

```bash
python3 -m virtualenv .venv
.venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  -r requirements.txt

# Download ~2.3 GB of model weights from ModelScope (HF mirror in CN)
.venv/bin/python download_model.py
```

Or via the backend package wrapper:

```bash
cd ../.. && npm run embed:server:install
```

## Start

```bash
./start.sh                              # 127.0.0.1:18080
EMBED_PORT=18090 ./start.sh             # override port
EMBED_NUM_THREADS=32 ./start.sh         # pin torch threads
EMBED_BATCH_SIZE=16 ./start.sh          # default 8; tune per host
```

Healthcheck: `curl http://127.0.0.1:18080/health`

## API

```
POST /embed
Content-Type: application/json
{
  "inputs": ["文本1", "文本2"],
  "normalize": true,          // default true
  "batch_size": 8             // optional override
}
→ 200 OK
[[float, float, ...],  // length = inputs[0] dim
 [float, float, ...]]  // length = inputs[1] dim
```

Errors surface as HTTP 400/500 JSON `{detail: "..."}`.

## Notes

- CPU inference on a modern x86 box (AVX2): ~100-300ms / 512-token input
- Full backfill of ~34K SCPPER pages: batch=8 → 1-2h; batch=16 → 45-90min
- Model weights live in `./models/bge-m3/` (~2.3 GB). `.gitignore` keeps them
  out of the repo.
- TEI protocol compatibility is intentional: `POST /embed` with the same body
  shape works against both this server and a real TEI container; you can
  later `docker run ghcr.io/huggingface/text-embeddings-inference:cpu-1.8
  --model-id BAAI/bge-m3` and point `EMBEDDING_SERVER_URL` at it.

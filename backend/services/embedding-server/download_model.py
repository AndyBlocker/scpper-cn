"""Download BGE-M3 via ModelScope mirror (avoids HF network issues in CN).

Usage:
    python download_model.py               # default: BAAI/bge-m3 → ./models/bge-m3
    python download_model.py --model X     # override model id
    python download_model.py --dest P      # override dest dir
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="BAAI/bge-m3", help="ModelScope model id")
    parser.add_argument(
        "--dest",
        default=str(Path(__file__).parent / "models" / "bge-m3"),
        help="Local dir to cache weights into",
    )
    args = parser.parse_args()

    dest = Path(args.dest).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    from modelscope import snapshot_download  # type: ignore

    print(f"Downloading {args.model} → {dest}", flush=True)
    snapshot_download(
        model_id=args.model,
        cache_dir=str(dest.parent),
        local_dir=str(dest),
    )
    print(f"OK. Model at: {dest}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

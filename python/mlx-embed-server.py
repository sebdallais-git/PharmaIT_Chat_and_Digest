#!/usr/bin/env python3
"""OpenAI-compatible embedding server for Qwen3-Embedding on MLX.

Serves GET /v1/models and POST /v1/embeddings. Embeddings are the final hidden
state of the last token (the appended <|endoftext|>), L2-normalized, which is
how Qwen3-Embedding's reference implementation pools.

Usage:
  python/mlx-venv/bin/python python/mlx-embed-server.py \
    --model mlx-community/Qwen3-Embedding-0.6B-8bit --host 127.0.0.1 --port 8081
"""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import mlx.core as mx
from mlx_lm import load

MAX_TOKENS = 8192
EOS_TOKEN = "<|endoftext|>"


def cache_limit_bytes() -> int:
    """MLX keeps freed GPU buffers for reuse with no cap, and every embedding is a forward pass over a
    different number of tokens: uncapped, a test instance grew from 0.9 GB to 36 GB within 90 varied
    requests (2026-09-29), enough to push the 27B beside it into swap. 512 MiB held it at 1.5 GB with
    no loss of speed. Overridable with MLX_EMBED_CACHE_LIMIT (bytes)."""
    raw = os.environ.get("MLX_EMBED_CACHE_LIMIT", "536870912").strip()
    if not raw.isdigit():
        raise SystemExit(f"MLX_EMBED_CACHE_LIMIT must be a byte count, got {raw!r}")
    return int(raw)


class Embedder:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.model, self.tokenizer = load(model_id)
        self.eos_id = self.tokenizer.convert_tokens_to_ids(EOS_TOKEN)

    def embed(self, text: str) -> list[float]:
        ids = list(self.tokenizer.encode(text))[: MAX_TOKENS - 1]
        # Pooling reads the EOS position, so make sure the sequence ends with it
        if not ids or ids[-1] != self.eos_id:
            ids.append(self.eos_id)
        # model.model returns normalized hidden states without the LM head
        hidden = self.model.model(mx.array([ids]))
        last = hidden[0, -1, :]
        vector = last / mx.maximum(mx.linalg.norm(last), 1e-12)
        mx.eval(vector)
        return vector.tolist()


def make_handler(embedder: Embedder):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/v1/models":
                self._send(200, {"object": "list", "data": [{"id": embedder.model_id, "object": "model"}]})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/v1/embeddings":
                self._send(404, {"error": "not found"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid JSON"})
                return

            inputs = body.get("input")
            if isinstance(inputs, str):
                inputs = [inputs]
            if not isinstance(inputs, list) or not inputs or not all(isinstance(x, str) for x in inputs):
                self._send(400, {"error": "input must be a string or a non-empty list of strings"})
                return

            data = [
                {"object": "embedding", "index": i, "embedding": embedder.embed(text)}
                for i, text in enumerate(inputs)
            ]
            self._send(200, {"object": "list", "model": embedder.model_id, "data": data})

        def log_message(self, format: str, *args: object) -> None:
            # Keep the log readable during reindexing (thousands of requests)
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="mlx-community/Qwen3-Embedding-0.6B-8bit")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()

    mx.set_cache_limit(cache_limit_bytes())
    embedder = Embedder(args.model)
    # Single-threaded on purpose: MLX evaluation isn't safe to run from several threads
    server = HTTPServer((args.host, args.port), make_handler(embedder))
    print(f"MLX embedding server ready: {args.model} on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

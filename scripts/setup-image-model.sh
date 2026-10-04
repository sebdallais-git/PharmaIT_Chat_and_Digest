#!/bin/bash
# Installs the local image model (spec 2026-10-04): mflux in its own venv
# (.venv-image, separate from open-jev's) and FLUX.1-schnell saved quantized
# under data/models/flux-schnell-<bits>bit, so every later image is offline.
#
#   scripts/setup-image-model.sh
#
# The first run downloads FLUX.1-schnell once (~24 GB, Apache-2.0) and saves a
# quantized copy (~6 GB at 4 bits); re-running is a no-op. The bit depth comes
# from config/host.yaml resources.image.quantize.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${IMAGE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
UV="${UV_BIN:-uv}"
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
BITS="${IMAGE_QUANTIZE:?IMAGE_QUANTIZE missing from config/host.yaml resources.image}"

VENV="$ROOT/.venv-image"
MODEL_DIR="$ROOT/data/models/flux-schnell-${BITS}bit"

if [ -x "$VENV/bin/mflux-generate" ] && [ -n "$(ls -A "$MODEL_DIR" 2>/dev/null)" ]; then
  echo "image model already set up: $MODEL_DIR"
  exit 0
fi

if [ ! -x "$VENV/bin/mflux-generate" ]; then
  # 3.12: MLX and mflux publish wheels for it; Homebrew's newest Python may be ahead of them
  "$UV" venv "$VENV" --python 3.12
  "$UV" pip install --python "$VENV/bin/python" mflux
fi

# The generator passes exactly these flags (src/services/image-generator.ts):
# refuse to download 24 GB for an mflux that would reject them
HELP="$("$VENV/bin/mflux-generate" --help 2>&1 || true)"
for flag in --model --path --prompt --steps --seed --width --height --output --low-ram; do
  if ! grep -q -- "$flag" <<<"$HELP"; then
    echo "mflux-generate does not support $flag: pin an mflux version that does, then re-run" >&2
    exit 1
  fi
done

mkdir -p "$ROOT/data/models"
# Save beside the final folder and move it in only on success: an interrupted
# save must not leave a half-written $MODEL_DIR that the check above accepts
rm -rf "$MODEL_DIR.partial"
"$VENV/bin/mflux-save" --model schnell --quantize "$BITS" --path "$MODEL_DIR.partial"
mv "$MODEL_DIR.partial" "$MODEL_DIR"
echo "image model ready: $MODEL_DIR"

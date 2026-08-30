#!/usr/bin/env bash
# One-command Core ML go/no-go benchmark. Local only; downloads ~1.7 GB once.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet "coremltools>=8.0" "numpy" "huggingface_hub>=0.20"
exec .venv/bin/python probe.py "$@"

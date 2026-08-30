#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

if [[ ! -x .venv-mac/bin/python ]]; then
  echo "Mac runtime not installed. Run ./setup_mac.sh first." >&2
  exit 1
fi

export SURFACESHIFT_BACKEND=mac
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec .venv-mac/bin/python app.py

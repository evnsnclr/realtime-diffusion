#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env.local ]]; then
  # Parse instead of source: dotenv values must never execute as shell.
  while IFS='=' read -r name value; do
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$name=$value"
  done < .env.local
fi

if [[ ! -x .venv-mac/bin/python ]]; then
  echo "Mac runtime not installed. Run ./setup_mac.sh first." >&2
  exit 1
fi

export SURFACESHIFT_BACKEND=mac
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec .venv-mac/bin/python app.py

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

export SURFACESHIFT_BACKEND=preview
export PORT="${PORT:-7860}"

PYTHON=python3
if [[ -x .venv/bin/python ]]; then
  PYTHON=.venv/bin/python
fi

"$PYTHON" app.py

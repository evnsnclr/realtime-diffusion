#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

export SURFACESHIFT_BACKEND=preview
export PORT="${PORT:-7860}"

PYTHON=python3
if [[ -x .venv/bin/python ]]; then
  PYTHON=.venv/bin/python
fi

"$PYTHON" app.py

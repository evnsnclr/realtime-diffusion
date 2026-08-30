#!/usr/bin/env bash
# Settles whether an idle realtime connection bills anything. Uses YOUR fal
# account (key from ../../.env.local); sends no frames, expected cost $0.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet "websockets>=12" "httpx>=0.27"
exec .venv/bin/python probe.py "$@"

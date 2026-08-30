#!/usr/bin/env bash
# One-command setup: virtualenv, dependencies, and a ready .env.local.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found. Install Python 3.10 or newer first." >&2
  exit 1
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "error: Python 3.10+ required, found $(python3 --version 2>&1)." >&2
  exit 1
fi

if [[ ! -d .venv ]]; then
  echo "Creating virtualenv in .venv ..."
  python3 -m venv .venv
fi

echo "Installing dependencies ..."
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements-local.txt

ACCESS_CODE=""
if [[ -f .env.local ]]; then
  echo ".env.local already exists — leaving it untouched."
else
  ACCESS_CODE="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  FAL_KEY_VALUE="${FAL_KEY:-}"
  if [[ -z "$FAL_KEY_VALUE" && -t 0 ]]; then
    echo
    echo "Paste your fal API key (from https://fal.ai/dashboard/keys)."
    echo "Leave it empty to run the free, non-AI interface preview for now."
    read -rs -p "FAL_KEY: " FAL_KEY_VALUE
    echo
  fi
  umask 177
  cat > .env.local <<ENV
# Written by setup.sh. Never commit real values.
FAL_KEY=${FAL_KEY_VALUE}
# Local gate for the token endpoint, generated for you. Not a fal credential.
SURFACESHIFT_ACCESS_CODE=${ACCESS_CODE}
ENV
  umask 022
  chmod 600 .env.local
fi

echo
echo "Setup complete."
if [[ -n "$ACCESS_CODE" ]]; then
  echo "Your local access code (the app asks for it before each cloud session):"
  echo
  echo "  ${ACCESS_CODE}"
  echo
  echo "It is stored in .env.local if you need it again."
fi
echo "Start the demo with:  ./run_demo.sh"
echo "Then open:            http://127.0.0.1:7860"

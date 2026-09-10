#!/usr/bin/env bash
# Standalone setup for the web-fetch extension package.
# Installs Python deps into this package's local .venv and ensures the
# Chromium browser binary is available — no global `crwl`/venv required.
set -euo pipefail
cd "$(dirname "$0")"   # this package directory

VENV=".venv"
PY="$VENV/bin/python3"

if [ ! -x "$PY" ]; then
  echo "Creating venv at $VENV ..."
  uv venv --python 3.12
fi

echo "Installing Python dependencies ..."
uv pip install --upgrade pip
uv pip install -r requirements.txt

echo "Ensuring Chromium browser is installed ..."
"$PY" -m playwright install chromium

echo "Done. The web-fetch extension now runs from this package's .venv."

#!/usr/bin/env bash
# Standalone setup for the web-fetch (Crawl4AI) extension package.
# Installs Python deps into this package's local .venv and ensures the
# Chromium browser binary is available — no global `crwl`/venv required.
set -euo pipefail
cd "$(dirname "$0")"   # this package directory

VENV=".venv"
PY="$VENV/bin/python3"

if [ ! -x "$PY" ]; then
  echo "Creating venv at $VENV ..."
  python3 -m venv "$VENV"
fi

echo "Installing Python dependencies ..."
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r requirements.txt

echo "Ensuring Chromium browser is installed ..."
"$PY" -m playwright install chromium

echo "Done. The web-fetch extension now runs from this package's .venv."

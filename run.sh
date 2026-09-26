#!/usr/bin/env bash
# Start TinyCutOpus at http://localhost:8747
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3)
  "$PY" -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
PORT="${PORT:-8747}"
( sleep 1.5 && .venv/bin/python -m webbrowser "http://localhost:$PORT" ) >/dev/null 2>&1 &
exec .venv/bin/uvicorn server:app --host 127.0.0.1 --port "$PORT"

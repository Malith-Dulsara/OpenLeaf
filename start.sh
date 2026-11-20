#!/usr/bin/env sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
command -v latexmk >/dev/null || echo "WARNING: latexmk not found on PATH. Install TeX Live / MacTeX."
exec node server.js --open "$@"

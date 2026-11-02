#!/usr/bin/env bash
# Builds the frontend and backend, then serves the app at http://127.0.0.1:8787
set -euo pipefail
cd "$(dirname "$0")"

GO=$(command -v /opt/homebrew/bin/go || command -v go)

(cd frontend && [ -d node_modules ] || npm install) && (cd frontend && npm run build)
(cd backend && "$GO" build -o bin/server .)
cd backend && exec ./bin/server "$@"

#!/usr/bin/env bash
# Starts the LiteLLM proxy that fronts Groq for Claude Router.
# Usage: GROQ_API_KEY=gsk_... scripts/start-proxy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${GROQ_API_KEY:-}" ]; then
  echo "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys, then run:" >&2
  echo "  GROQ_API_KEY=gsk_... scripts/start-proxy.sh" >&2
  exit 1
fi
exec .litellm-venv/bin/litellm --config litellm.yaml --port 4000

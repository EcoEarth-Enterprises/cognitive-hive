#!/usr/bin/env bash
#
# Smoke test the Hire Existing Agent flow for the openclaw-gateway adapter.
# Exercises POST /api/adapters/openclaw_gateway/discover followed by
# POST /api/companies/{id}/agent-imports against a running paperclip instance.
#
# Requirements:
#   - curl, jq
#   - Paperclip running and reachable at $PAPERCLIP_API_URL (default localhost:3100)
#   - OpenClaw gateway running at $OPENCLAW_GATEWAY_URL (default ws://127.0.0.1:18789)
#   - Authentication to paperclip provided via PAPERCLIP_AUTH_HEADER or PAPERCLIP_COOKIE
#   - COMPANY_ID env var with the target company id

set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"
COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
AGENT_NAME="${AGENT_NAME:-OpenClaw Import Smoke}"
AGENT_ROLE="${AGENT_ROLE:-general}"

AUTH_HEADERS=()
if [[ -n "${PAPERCLIP_AUTH_HEADER:-}" ]]; then
  AUTH_HEADERS+=(-H "Authorization: ${PAPERCLIP_AUTH_HEADER}")
fi
if [[ -n "${PAPERCLIP_COOKIE:-}" ]]; then
  AUTH_HEADERS+=(-H "Cookie: ${PAPERCLIP_COOKIE}")
fi

if [[ -z "$COMPANY_ID" ]]; then
  echo "COMPANY_ID is required (or set PAPERCLIP_COMPANY_ID)" >&2
  exit 1
fi

echo "1. Discovering agents at $OPENCLAW_GATEWAY_URL"
DISCOVER_RESP="$(curl -sS -f -X POST "${API_BASE}/adapters/openclaw_gateway/discover" \
  "${AUTH_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"connectionConfig\":{\"url\":\"${OPENCLAW_GATEWAY_URL}\"}}")"
echo "$DISCOVER_RESP" | jq '.agents | map({id, name, status})'

AGENT_ID="$(echo "$DISCOVER_RESP" | jq -r '.agents[0].id // empty')"
if [[ -z "$AGENT_ID" ]]; then
  echo "No agents discovered at $OPENCLAW_GATEWAY_URL" >&2
  exit 1
fi

echo ""
echo "2. Importing first discovered agent (id=$AGENT_ID) as \"$AGENT_NAME\""
IMPORT_RESP="$(curl -sS -f -X POST "${API_BASE}/companies/${COMPANY_ID}/agent-imports" \
  "${AUTH_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc \
    --arg name "$AGENT_NAME" \
    --arg role "$AGENT_ROLE" \
    --arg url "$OPENCLAW_GATEWAY_URL" \
    --arg agentId "$AGENT_ID" \
    '{name:$name, role:$role, adapterType:"openclaw_gateway", adapterConfig:{url:$url, agentId:$agentId}}')")"

IMPORTED_AGENT_ID="$(echo "$IMPORT_RESP" | jq -r '.agent.id')"
API_KEY_TOKEN="$(echo "$IMPORT_RESP" | jq -r '.apiKey.token')"
APPROVAL_STATUS="$(echo "$IMPORT_RESP" | jq -r '.approval.status // "none"')"

echo "   agent.id=$IMPORTED_AGENT_ID"
echo "   approval.status=$APPROVAL_STATUS"
echo "   apiKey.token=${API_KEY_TOKEN:0:12}…(redacted)"

echo ""
echo "3. Verifying agent record"
curl -sS -f "${API_BASE}/agents/${IMPORTED_AGENT_ID}" "${AUTH_HEADERS[@]}" \
  | jq '{id, name, status, adapterType, reportsTo, adapterConfig: .adapterConfig | {url, agentId}}'

echo ""
echo "Smoke test passed."

#!/usr/bin/env bash
# List the tool names an MCP server actually exposes.
#
#   mcp/probe-tools.sh 8100                          # grafana
#   mcp/probe-tools.sh 8105 "$N8N_MCP_AUTH_TOKEN"    # bearer-protected
#
# Worth having as a script rather than a one-liner: the harness *silently
# ignores* a `preloadTools` entry that does not match a real tool, so a
# plausible-looking name copied out of documentation degrades the agent with no
# error anywhere. Every name in agent/agent.ts should have come from this.
#
# Streamable-HTTP MCP is a handshake, not a REST endpoint — there is no
# GET /tools/list to curl. Initialize, echo back any session id the server
# hands you, say `notifications/initialized`, and only then ask.
set -euo pipefail

port="${1:?usage: probe-tools.sh <port> [bearer]}"
bearer="${2:-}"
url="http://127.0.0.1:$port/mcp"

# macOS still ships bash 3.2, where `"${arr[@]}"` on an *empty* array trips
# `set -u`. The `${arr[@]+...}` guard is the portable expand-or-omit idiom.
auth=()
[ -n "$bearer" ] && auth=(-H "authorization: Bearer $bearer")

# Both content types, because a server may answer as JSON or as an SSE stream.
common=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT

code=$(curl -s -o /dev/null -D "$headers" -w '%{http_code}' -X POST "$url" \
  ${auth[@]+"${auth[@]}"} "${common[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe-tools","version":"1"}}}')

if [ "$code" != "200" ]; then
  echo "initialize failed: HTTP $code" >&2
  [ "$code" = "401" ] && echo "  (this server wants a bearer — pass it as the second argument)" >&2
  exit 1
fi

# Stateful servers (mcp/grafana, n8n-mcp) hand back a session id and expect it
# on every later call. Stateless ones (the supergateway bridges) send no such
# header — so a failed grep here is normal, not an error, and must not be
# allowed to kill the script under `set -e`.
session=$(grep -i '^mcp-session-id' "$headers" | tr -d '\r' | cut -d' ' -f2 || true)
sid=()
[ -n "$session" ] && sid=(-H "mcp-session-id: $session")

curl -s -o /dev/null -X POST "$url" \
  ${auth[@]+"${auth[@]}"} "${common[@]}" ${sid[@]+"${sid[@]}"} \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST "$url" \
  ${auth[@]+"${auth[@]}"} "${common[@]}" ${sid[@]+"${sid[@]}"} \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | tr -d '\r' | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | sort -u

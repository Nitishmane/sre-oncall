#!/usr/bin/env bash
# Start the MCP bridges, preparing anything they need first.
#
# The only genuinely awkward one is Kubernetes: kind writes a kubeconfig whose
# server is https://127.0.0.1:<random-port>, which is meaningless inside a
# container. We rewrite it to the node container's address on the kind network
# and mount that copy read-only.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${CLUSTER:-sre-oncall}"
out="$root/mcp/.kube-config-container"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need docker; need kubectl

if kubectl config get-contexts "kind-$CLUSTER" >/dev/null 2>&1; then
  node_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "${CLUSTER}-control-plane")"
  [ -n "$node_ip" ] || { echo "could not find the kind node's address" >&2; exit 1; }

  kubectl config view --minify --flatten --context "kind-$CLUSTER" \
    | sed -E "s#server: https://127\.0\.0\.1:[0-9]+#server: https://${node_ip}:6443#" > "$out"
  chmod 600 "$out"
  echo "wrote $out (server https://${node_ip}:6443)"
else
  echo "no kind-$CLUSTER context; skipping the kubernetes bridge's kubeconfig"
fi

# Only bridges whose credentials are present start; the rest exit and restart,
# which is noisy, so name them explicitly.
services=(mcp-grafana mcp-terraform)
[ -f "$out" ] && services+=(mcp-kubernetes)
[ -n "${ARGOCD_API_TOKEN:-}" ] && services+=(mcp-argocd)
[ -n "${NOTION_TOKEN:-}" ] && services+=(mcp-notion)

echo "starting: ${services[*]}"
docker compose -f "$root/mcp/compose.yaml" --env-file "$root/.env" up -d "${services[@]}"

cat <<EOF

Bridges are on 8100-8104. Check what the harness can see:
  curl -s localhost:8790/api/v1/mcp-servers/grafana/tools | jq '.data | length'
EOF

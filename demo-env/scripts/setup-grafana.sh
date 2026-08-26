#!/usr/bin/env bash
# Mint a Grafana service-account token, discover the Prometheus datasource, and
# apply the alerting configuration from demo-env/terraform.
#
# Terraform is the single source of truth for Grafana alerting (rules, contact
# point, notification policy). ArgoCD owns the workload. Nothing else writes to
# either, so there is no drift to reconcile.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_ADMIN="${GRAFANA_ADMIN:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-admin}"
SA_NAME="sre-oncall"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need curl; need jq; need terraform

api() {
  curl -sS -u "$GRAFANA_ADMIN:$GRAFANA_ADMIN_PASSWORD" \
    -H 'content-type: application/json' "$@"
}

echo "==> waiting for Grafana at $GRAFANA_URL"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$GRAFANA_URL/api/health"; then break; fi
  sleep 2
done
curl -sf -o /dev/null "$GRAFANA_URL/api/health" || {
  echo "Grafana never became reachable. Is the port mapping up? kubectl -n monitoring get svc" >&2
  exit 1
}

echo "==> service account '$SA_NAME'"
sa_id="$(api "$GRAFANA_URL/api/serviceaccounts/search?query=$SA_NAME" \
  | jq -r --arg n "$SA_NAME" '.serviceAccounts[]? | select(.name==$n) | .id' | head -1)"

if [ -z "$sa_id" ]; then
  sa_id="$(api -X POST "$GRAFANA_URL/api/serviceaccounts" \
    -d "{\"name\":\"$SA_NAME\",\"role\":\"Admin\"}" | jq -r '.id')"
  echo "    created (id $sa_id)"
else
  echo "    exists (id $sa_id)"
fi

# Tokens are write-once: Grafana never shows the value again, so mint a fresh
# one each run and let the old ones expire.
token="$(api -X POST "$GRAFANA_URL/api/serviceaccounts/$sa_id/tokens" \
  -d "{\"name\":\"sre-oncall-$(date +%s)\"}" | jq -r '.key')"
[ -n "$token" ] && [ "$token" != "null" ] || { echo "failed to mint a token" >&2; exit 1; }

echo "==> Prometheus datasource"
ds_uid="$(api "$GRAFANA_URL/api/datasources" \
  | jq -r '.[] | select(.type=="prometheus") | .uid' | head -1)"
[ -n "$ds_uid" ] || { echo "no Prometheus datasource found — is kube-prometheus-stack installed?" >&2; exit 1; }
echo "    uid $ds_uid"

# shellcheck disable=SC1091
set -a; [ -f "$root/.env" ] && source "$root/.env"; set +a
: "${GRAFANA_WEBHOOK_BEARER:?set GRAFANA_WEBHOOK_BEARER in .env (openssl rand -hex 32)}"

echo "==> terraform apply"
terraform -chdir="$root/demo-env/terraform" init -input=false >/dev/null
terraform -chdir="$root/demo-env/terraform" apply -input=false -auto-approve \
  -var "grafana_url=$GRAFANA_URL" \
  -var "grafana_token=$token" \
  -var "webhook_bearer=$GRAFANA_WEBHOOK_BEARER" \
  -var "prometheus_datasource_uid=$ds_uid"

cat <<EOF

Alerting is configured. Put this in .env for the Grafana MCP:

  GRAFANA_URL=$GRAFANA_URL
  GRAFANA_TOKEN=$token

(The token is shown once. Re-run this script to mint another.)
EOF

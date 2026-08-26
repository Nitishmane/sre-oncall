#!/usr/bin/env bash
# Substitute secrets from .env into the Grafana provisioning files and write the
# rendered copies to demo-env/.rendered/ (gitignored). Never commit the output:
# it contains the webhook bearer.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$root/demo-env/.rendered"

# shellcheck disable=SC1091
set -a; source "$root/.env"; set +a

: "${GRAFANA_WEBHOOK_BEARER:?set GRAFANA_WEBHOOK_BEARER in .env}"

mkdir -p "$out"
for file in contact-point alert-rules; do
  envsubst '${GRAFANA_WEBHOOK_BEARER}' \
    < "$root/demo-env/grafana/$file.yaml" > "$out/$file.yaml"
  echo "rendered $out/$file.yaml"
done

cat <<EOF

Apply to the cluster's Grafana:
  kubectl -n monitoring create secret generic grafana-provisioning \\
    --from-file=$out/contact-point.yaml \\
    --from-file=$out/alert-rules.yaml \\
    --dry-run=client -o yaml | kubectl apply -f -

then mount it at /etc/grafana/provisioning/alerting (see demo-env/README.md).
EOF

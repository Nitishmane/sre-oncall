#!/usr/bin/env bash
# Build the demo environment from nothing: kind cluster, monitoring stack,
# ArgoCD, and the demo service. Safe to re-run.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER="${CLUSTER:-sre-oncall}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need docker; need kind; need kubectl; need helm

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "kind cluster '$CLUSTER'"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "already exists"
else
  kind create cluster --config "$root/demo-env/kind-cluster.yaml"
fi
kubectl cluster-info --context "kind-$CLUSTER" >/dev/null

step "demo-service image"
docker build -t demo-service:0.1.0 "$root/demo-env/demo-service"
kind load docker-image demo-service:0.1.0 --name "$CLUSTER"

step "kube-prometheus-stack"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo update >/dev/null
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30300 \
  --set grafana.adminPassword=admin \
  --set prometheus.prometheusSpec.scrapeInterval=15s \
  --wait --timeout 10m

step "ArgoCD"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deployment/argocd-server --timeout=5m

step "demo service"
kubectl apply -f "$root/demo-env/k8s/"
kubectl -n demo rollout status deployment/demo-service --timeout=3m

step "cluster → host reachability"
# Grafana's webhook contact point has to reach the orchestrator on the host.
# Verify the address now rather than discovering it during the demo.
if kubectl -n demo run reach-check --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- \
     curl -s -m 3 -o /dev/null -w '%{http_code}' http://host.docker.internal:8080/healthz 2>/dev/null | grep -q 200; then
  echo "host.docker.internal:8080 reachable from the cluster ✓"
else
  echo "WARNING: the cluster could not reach host.docker.internal:8080."
  echo "  Start the orchestrator first (npm run dev:orchestrator), then re-run this check."
  echo "  If it still fails, use the host IP shown by:  ipconfig getifaddr en0"
fi

cat <<EOF

Ready.

  Grafana    http://localhost:3000        (admin / admin)
  ArgoCD     kubectl -n argocd port-forward svc/argocd-server 8081:443
  Demo app   kubectl -n demo port-forward svc/demo-service 8000:8000

Next:
  1. ./render-grafana-config.sh   and load the alert rules + contact point
  2. npm run dev:orchestrator      (host, port 8080)
  3. npx @truefoundry/trueforge    (host, port 8790)
  4. npm run provision             (registers the agent, MCP servers, skills)
  5. ./inject-fault.sh errors      (watch the pipeline run)
EOF

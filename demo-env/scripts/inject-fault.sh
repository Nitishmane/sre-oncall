#!/usr/bin/env bash
# Inject a fault into the demo service by editing its fault ConfigMap and
# restarting the rollout — a real Kubernetes change, with real events, that the
# agent has to discover for itself.
#
#   ./inject-fault.sh errors     5xx ratio ~20%       → HighErrorRate
#   ./inject-fault.sh latency    +800ms per request   → HighLatencyP99
#   ./inject-fault.sh leak       80 MB/min            → OOMKilled, then restarts
#   ./inject-fault.sh crash      exits after 3s       → ContainerRestartsSpiking
set -euo pipefail

NAMESPACE="${NAMESPACE:-demo}"
CONFIGMAP="demo-service-faults"
DEPLOYMENT="demo-service"

fault="${1:-}"
case "$fault" in
  errors)  patch='{"FAULT_ERROR_RATE":"0.2","FAULT_LATENCY_MS":"0","FAULT_LEAK_MB_PER_MINUTE":"0","FAULT_CRASH_ON_START":"false"}' ;;
  latency) patch='{"FAULT_ERROR_RATE":"0","FAULT_LATENCY_MS":"800","FAULT_LEAK_MB_PER_MINUTE":"0","FAULT_CRASH_ON_START":"false"}' ;;
  leak)    patch='{"FAULT_ERROR_RATE":"0","FAULT_LATENCY_MS":"0","FAULT_LEAK_MB_PER_MINUTE":"80","FAULT_CRASH_ON_START":"false"}' ;;
  crash)   patch='{"FAULT_ERROR_RATE":"0","FAULT_LATENCY_MS":"0","FAULT_LEAK_MB_PER_MINUTE":"0","FAULT_CRASH_ON_START":"true"}' ;;
  *)
    echo "usage: $0 {errors|latency|leak|crash}" >&2
    exit 64
    ;;
esac

echo "Injecting '$fault' into $NAMESPACE/$CONFIGMAP"
kubectl -n "$NAMESPACE" patch configmap "$CONFIGMAP" --type merge -p "{\"data\":$patch}"
kubectl -n "$NAMESPACE" rollout restart "deployment/$DEPLOYMENT"
kubectl -n "$NAMESPACE" rollout status "deployment/$DEPLOYMENT" --timeout=90s || true

cat <<EOF

Fault '$fault' is live. Expect the alert to fire in 1-3 minutes.

Watch it arrive:
  kubectl -n $NAMESPACE get pods -w
  curl -s localhost:8080/healthz | jq

Reset with:
  ./heal-reset.sh
EOF

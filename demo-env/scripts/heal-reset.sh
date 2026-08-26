#!/usr/bin/env bash
# Return the demo service to steady state between rehearsals.
set -euo pipefail

NAMESPACE="${NAMESPACE:-demo}"

echo "Clearing faults in $NAMESPACE"
kubectl -n "$NAMESPACE" patch configmap demo-service-faults --type merge -p '{"data":{
  "FAULT_ERROR_RATE":"0",
  "FAULT_LATENCY_MS":"0",
  "FAULT_LEAK_MB_PER_MINUTE":"0",
  "FAULT_CRASH_ON_START":"false"
}}'
kubectl -n "$NAMESPACE" rollout restart deployment/demo-service
kubectl -n "$NAMESPACE" rollout status deployment/demo-service --timeout=90s

echo
echo "Steady state restored. The firing alert resolves within ~2 minutes,"
echo "which is what triggers the postmortem session."

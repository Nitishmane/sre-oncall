# Demo environment

A local kind cluster that can be broken on demand, so the healing pipeline has
something real to heal.

## What bootstrap.sh builds

- a single-node **kind** cluster (`sre-oncall`) with host ports mapped for
  Grafana, ArgoCD and the demo service
- **kube-prometheus-stack** — Prometheus, Grafana, Alertmanager,
  kube-state-metrics
- **ArgoCD**, so a "bad deploy" is a real sync the agent can find and roll back
- **demo-service** (3 replicas) plus a load generator, so the error-rate alert
  has a denominator

It finishes by checking that the cluster can reach the orchestrator on the host
at `host.docker.internal:8080` — the hop Grafana's webhook contact point depends
on. Verify this before demo day, not during it.

## The faults

| `inject-fault.sh <fault>` | What happens | Alert | Runbook |
|---|---|---|---|
| `errors` | ~20% of responses become 500 | `HighErrorRate` | `high-error-rate.md` |
| `latency` | +800ms per request | `HighLatencyP99` | `connection-pool-exhaustion.md` |
| `leak` | 80 MB/min, hits the 128Mi limit in ~2 min | `OOMKilled`, then `ContainerRestartsSpiking` | `pod-crashloop-oom.md` |
| `crash` | container exits 3s after start | `ContainerRestartsSpiking`, `ReplicasUnavailable` | `pod-crashloop-oom.md` |

Faults live in the `demo-service-faults` ConfigMap and take effect through a
rollout restart, so each injection produces genuine Kubernetes events and a
genuine deploy the agent has to correlate against. There is no runtime toggle —
a live switch would let the demo cheat.

`heal-reset.sh` clears every fault and restarts the rollout. The alert resolves
within about two minutes, and that `resolved` webhook is what starts the
postmortem session.

## Who owns what

| System | Owns | Why |
|---|---|---|
| **ArgoCD** | the workload (`k8s/`) | A fault injection becomes a real sync the agent can find in deploy history and roll back |
| **Terraform** | Grafana alerting (`terraform/`) | Threshold and rule changes are reviewable HCL with a `terraform plan` the agent can attach to a PR |

Nothing owns both, so there is no drift to reconcile — and each kind of fix has
exactly one place it belongs.

`setup-grafana.sh` mints a Grafana service-account token over the admin API,
discovers the Prometheus datasource UID, and runs `terraform apply`. The token is
shown once; put it in `.env` as `GRAFANA_TOKEN` for the Grafana MCP. The webhook
bearer comes from `.env` and is never written to a file in the repo.

`wire-argocd.sh` points `argocd/application.yaml` at this repository's own git
remote and prints the steps for minting the ArgoCD API token the MCP needs.
Auto-sync is deliberately off: it would silently revert a rollback.

The demo rules evaluate every 30s with `for:` durations of 0–2 minutes, so a full
cycle fits in a demo. The kube-prometheus-stack built-ins (`KubePodCrashLooping`
and friends) stay enabled underneath as background coverage; their 10–15 minute
`for:` durations make them useless as demo drivers but they exercise the same
webhook path. `Watchdog` fires continuously by design and is dropped by the
orchestrator's default skip pattern — it is the easiest way to prove the webhook
path works before any real alert exists.

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

## Grafana provisioning

`grafana/alert-rules.yaml` and `grafana/contact-point.yaml` are templates: the
contact point contains `${GRAFANA_WEBHOOK_BEARER}`. `render-grafana-config.sh`
substitutes from `.env` into `demo-env/.rendered/` (gitignored). Never commit the
rendered files.

The demo rules evaluate every 30s with `for:` durations of 0–2 minutes, so a full
cycle fits in a demo. The kube-prometheus-stack built-ins (`KubePodCrashLooping`
and friends) stay enabled underneath as background coverage; their 10–15 minute
`for:` durations make them useless as demo drivers but they exercise the same
webhook path. `Watchdog` fires continuously by design and is dropped by the
orchestrator's default skip pattern — it is the easiest way to prove the webhook
path works before any real alert exists.

---
name: sre-runbooks
description: Runbooks and report formats for on-call incident response on this Kubernetes platform. Load a runbook when an alert or investigation matches its failure signature; load a template when writing a triage report, postmortem, or shift handoff.
---

# SRE runbooks

Match the failure signature first, then open exactly one runbook. If two match,
the more specific one wins. If none match, investigate from first principles and
say in your report that no runbook covered this — that gap is worth recording.

Two of these are routers rather than destinations: `replicas-unavailable.md` and
`latency-p99.md` both start from a symptom with several possible causes and hand
you off once you have named one. Follow the handoff rather than trying to
remediate from the symptom.

| Signature you observed | Runbook |
|---|---|
| Pod restarting repeatedly; `CrashLoopBackOff`; last state `OOMKilled`; memory approaching the container limit | `runbooks/pod-crashloop-oom.md` |
| 5xx ratio above threshold while pods stay Ready | `runbooks/high-error-rate.md` |
| Anything that began within ~15 minutes of an ArgoCD sync | `runbooks/bad-deploy-rollback.md` |
| Latency climbing with `connection pool`, `too many clients`, or timeout errors in logs | `runbooks/connection-pool-exhaustion.md` |
| `FailedScheduling`, `ImagePullBackOff`, evictions — event-only failures with no metric signal | `runbooks/event-only-failures.md` |
| `ReplicasUnavailable` — fewer Ready replicas than the deployment wants | `runbooks/replicas-unavailable.md` |
| `HighLatencyP99` — p99 above threshold while the error rate is normal | `runbooks/latency-p99.md` |
| The alert is firing but the service is fine; flapping; `DatasourceNoData` | `runbooks/alert-quality.md` |

## Report formats

Use these verbatim; the on-call rotation reads them at speed and expects the
shape to be stable.

- `templates/triage-report.md` — what you post at the end of a healing session.
- `templates/postmortem.md` — the Notion Postmortems database page.
- `templates/oncall-handoff.md` — the shift-change summary.

## Conventions across all runbooks

- The demo service runs in namespace `demo`, deployment `demo-service`, managed
  by the ArgoCD application `demo-service`.
- Prometheus is reached through the Grafana MCP (`query_prometheus`, and
  `query_prometheus_histogram` for latency quantiles), not directly. Alert rules
  and their current state come from `alerting_manage_rules`. Kubernetes events
  older than about an hour live in Loki, reachable with `query_loki_logs` under
  `{job="kubernetes-events"}`. Panels render as images with `get_panel_image` —
  useful for embedding evidence in a postmortem.
- Live cluster state comes from the Kubernetes MCP: `pods_list_in_namespace`,
  `pods_get`, `events_list`, and `pods_log` (pass `previous: true` to read the
  container that died). Mutations go through `resources_create_or_update`,
  `resources_scale` and `resources_delete` — all gated.
- Every mutation is gated. Propose, wait for approval, then act, then verify.
- "Verified" means the alerting expression itself crossed back under its
  threshold — not that a pod went Ready.

# High p99 latency

**Signature.** `HighLatencyP99` is firing: p99 for `demo-service` is above 500ms
for more than two minutes, while the error rate may be entirely normal.

```promql
histogram_quantile(0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket{service="demo-service"}[5m])))
```

Slow is harder than broken. A service returning 200s in 4 seconds looks healthy
to every check except this one, so the evidence has to come from the shape of
the latency, not from anything being obviously down.

## Establish the shape before the cause

Three questions, in this order. Each one eliminates whole families of cause.

**1. Is it everything, or the tail?** Compare p99 against p50 over the same
window:

```promql
histogram_quantile(0.50,
  sum by (le) (rate(http_request_duration_seconds_bucket{service="demo-service"}[5m])))
```

- **p50 flat, p99 up** — a subset of requests is slow. Look for a dependency, a
  lock, a cold cache, or one expensive route. The median user is fine.
- **p50 up too** — everything is slow. That is saturation or a downstream that
  is slow for every call.

**2. When did it start, and what changed then?** Widen the window to at least
six hours. A **step** points at a deploy or a config change; a **ramp** points
at something filling up — a pool, a queue, a disk, a table without an index.

If the step lands within ~15 minutes of an ArgoCD sync (`get_application_events`),
stop here and go to `bad-deploy-rollback.md`.

**3. Is the service saturated, or waiting?** This is the branch that decides
the fix, and the two look identical from outside.

```promql
rate(container_cpu_usage_seconds_total{namespace="demo", container="demo-service"}[5m])
```

- **CPU at its limit** — the service is throttled. It is doing work it cannot
  keep up with.
- **CPU low while latency is high** — it is *waiting*, not working. Something
  downstream is slow, or it is blocked on a pool.

## Follow the branch

| Shape | Likely cause | Where to go |
|---|---|---|
| CPU low, `connection pool` / `too many clients` / timeouts in logs | Pool exhaustion | `connection-pool-exhaustion.md` |
| Step change at a deploy | Bad release | `bad-deploy-rollback.md` |
| CPU pinned at the limit, traffic also up | Genuine capacity | below |
| CPU pinned, traffic flat | A regression made the same work cost more | `bad-deploy-rollback.md` first; if no deploy, report it |
| Ramp with no deploy and no saturation | Something is filling up — check pool, disk, and row counts | `connection-pool-exhaustion.md` |

Check request volume before concluding capacity:

```promql
sum(rate(http_requests_total{service="demo-service"}[5m]))
```

Latency rising *with* traffic is capacity. Latency rising while traffic is flat
is a regression, and adding replicas will hide it rather than fix it.

## Remediate

Smallest safe fix, and say which of the two you are doing:

- **Reverting a regression** — a PR against the deploy repo, per
  `bad-deploy-rollback.md`. Preferred whenever a deploy correlates.
- **Adding capacity** — a replica or limit change, in git, as a PR. Legitimate
  only when you have shown traffic actually grew. Write plainly in the PR that
  it is capacity, not a fix, if you have not found the cause.

Never respond to latency by widening the alert threshold. That is not
remediation, and this platform's alert rules are owned by Terraform anyway — see
`alert-quality.md` if you believe the rule itself is wrong.

## Verify

- p99 back under 500ms and **staying** there across at least two evaluation
  intervals. Latency is noisy; a single sample under the line proves nothing.
- p50 back to its pre-incident value. A p99 fix that leaves p50 elevated has
  moved the problem, not solved it.
- The alert transitions to Normal in Grafana alert state history.

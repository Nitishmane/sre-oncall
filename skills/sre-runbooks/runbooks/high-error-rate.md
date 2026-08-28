# High error rate

**Signature.** `HighErrorRate` firing — the 5xx ratio is over threshold while
pods remain Ready. The service is up and answering wrongly, which is worse than
being down.

## Scope it

```promql
sum(rate(http_requests_total{namespace="demo", status=~"5.."}[5m]))
  / sum(rate(http_requests_total{namespace="demo"}[5m]))
```

Then break the same expression down `by (pod)`, `by (route)`, and `by (status)`.
The breakdown tells you which shape of incident this is:

- **One pod, others clean** — that instance is sick. Check its events and logs;
  a restart of that pod is the smallest fix, but find out why first.
- **All pods, one route** — a code path or a dependency behind it.
- **All pods, all routes** — a shared dependency: database, cache, upstream API,
  config, or credentials that just expired.
- **502/503 rather than 500** — the app may not be the failing component at all;
  look at readiness probes and at whatever sits in front of it.

## Find the cause

1. Kubernetes MCP — container logs for a failing pod, filtered to the failing
   route. Read the *first* errors in the window, not the most recent: later ones
   are usually consequences.
2. ArgoCD MCP — sync history. Errors that begin sharply almost always begin at a
   deploy.
3. Grafana MCP — plot latency next to the error rate. Errors that follow rising
   latency point at saturation or a dependency; errors with flat latency point at
   a logic or config fault.
4. Grafana MCP → Loki — `{job="kubernetes-events"}` around the start time, for
   events that have already aged out of the live API.

## Remediate

- Caused by a deploy → roll back (`bad-deploy-rollback.md`).
- Caused by a dependency → the fix is usually not in this service; say so
  explicitly in the incident thread and name the owning team, rather than
  guessing at a workaround. Escalation reaches humans through the incident
  thread, not through a tool you call.
- Caused by config → open a PR against the manifest; never hand-edit the live
  ConfigMap.

## Verify

Re-run the exact alerting expression from the rule, not an approximation of it.
The ratio must be under threshold for the rule's full `for:` duration before you
call it healed.

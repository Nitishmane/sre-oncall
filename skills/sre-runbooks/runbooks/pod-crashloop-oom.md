# Pod crashloop / OOMKilled

**Signature.** `KubePodCrashLooping`, `ContainerRestartsSpiking`, or `OOMKilled`
is firing. Restart count is climbing. The pod may be Ready between restarts.

## Confirm the kill reason

The single fact that decides everything below is *why* the container exited.

1. Kubernetes MCP `pods_get` — pod status and last terminated state. `OOMKilled`
   means the kernel killed it for exceeding its memory limit. `Error` with a
   non-zero exit code means the process died on its own.
2. Kubernetes MCP `pods_log` with `previous: true`. The current container's logs
   are from after the restart and will tell you nothing. A panic, a failed
   migration, or a missing env var is visible here.
3. Grafana MCP — memory against the limit, over a window long enough to show the
   shape:

   ```promql
   container_memory_working_set_bytes{namespace="demo", container="demo-service"}
     / on(pod) kube_pod_container_resource_limits{namespace="demo", resource="memory"}
   ```

   A **sawtooth** (climbs to 1.0, drops, climbs again) is a leak or an
   unbounded buffer. A **step** to 1.0 that stays is a workload change or a
   limit that was lowered. **Flat and well under 1.0** means it is not memory —
   go back to the previous-container logs.

## Correlate

```promql
increase(kube_pod_container_status_restarts_total{namespace="demo"}[30m])
```

Check when restarts began, then check ArgoCD sync history for that time. If a
deploy lands within ~15 minutes before the first restart, switch to
`bad-deploy-rollback.md` — a rollback is faster and safer than diagnosing a leak
during an incident.

## Remediate

Choose by what you found, smallest first. All of these are gated.

| Finding | Fix |
|---|---|
| Started right after a deploy | Roll back that ArgoCD sync (see the rollback runbook) |
| Sawtooth, no recent deploy | Raise the memory limit as a **temporary** measure, open a PR for the leak, and say plainly in your report that the limit is a band-aid |
| Step change with no deploy | Look for a traffic or data-volume change; raising the limit may be the correct permanent fix |
| Not memory at all | Fix what the previous-container logs show — usually config, a dependency, or a failed migration |

For a limit change, edit the deployment manifest in the repository and open a
pull request through the GitHub MCP. Do not patch the live deployment directly:
ArgoCD will revert it at the next sync and you will have hidden the real state.

## Verify

- Restart count stops increasing for at least 5 minutes.
- Memory sits below the limit with headroom, not just under it.
- The alert transitions to Normal in Grafana alert state history. Wait for it.

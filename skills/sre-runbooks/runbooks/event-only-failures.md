# Event-only failures

**Signature.** A Loki-based alert on `{job="kubernetes-events"}` — a failure
visible only as a Kubernetes event: `FailedScheduling`, `ImagePullBackOff`,
`FailedMount`, evictions. Metrics look fine, because nothing is running to emit
metrics.

## Read the event, then the object

1. Grafana MCP → Loki: the events around the alert's start time. The event
   message names the object and usually the exact reason.
2. Kubernetes MCP: describe that object. Events explain the symptom; the object's
   spec explains the cause.

## By reason

| Reason | Usual cause | Fix |
|---|---|---|
| `FailedScheduling` — insufficient cpu/memory | A resource request larger than any node can satisfy, often just raised | Lower the request via PR, or roll back the change that raised it |
| `FailedScheduling` — node selector / taint | Selector or toleration change | Correct it in the manifest |
| `ImagePullBackOff` | Tag that was never pushed, or a registry credential | Check the tag exists; if it does not, the deploy is broken — roll back |
| `FailedMount` | PVC unbound or a missing secret | Check the PVC status and that the referenced secret exists |
| `Evicted` | Node pressure — disk or memory | Look at the node, not the pod; the pod is the victim |

## Note on history

Live events age out after roughly an hour. When reconstructing a timeline for a
postmortem, always query Loki rather than the live events API, and say which
source each fact came from.

## Verify

The pod reaches Running and Ready, and no new events of the same reason appear
for 5 minutes. For `FailedScheduling`, also confirm the node has headroom left —
scheduling one pod by shrinking its request can starve the next one.

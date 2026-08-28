# Replicas unavailable

**Signature.** `ReplicasUnavailable` is firing: the deployment wants more
replicas than are Ready.

```promql
avg_over_time(
  (
    kube_deployment_spec_replicas{namespace="demo", deployment="demo-service"}
      - kube_deployment_status_replicas_ready{namespace="demo", deployment="demo-service"}
  )[30s:10s]
)
```

This alert says *how many* pods are missing, never *why*. It is a symptom of
five different problems and your whole job in the first two minutes is deciding
which one. Do not propose a fix before you have named it.

## Read the gap first

`pods_list_in_namespace` on `demo`. Compare desired against what you see, and
sort the not-Ready pods by phase — the phase names the cause:

| What you see | What it means | Where to go |
|---|---|---|
| `CrashLoopBackOff`, restart count climbing | The container starts and dies | `pod-crashloop-oom.md` |
| `Pending` with `FailedScheduling` | No node will take it | `event-only-failures.md` |
| `ImagePullBackOff`, `ErrImagePull` | The tag does not exist or the pull failed | `event-only-failures.md` |
| `Running` but never Ready | The readiness probe is failing | below |
| Fewer pods than expected, no failures | A rollout is in progress, or something scaled it | below |

## Running but not Ready

This is the case people misread most often, because the container is fine and
the logs look healthy. The pod is up; Kubernetes just will not send it traffic.

1. `pods_get` — look at the readiness probe's failure message in the conditions.
2. `pods_log` **without** `previous` — the container is alive, so its current
   logs are the relevant ones. A probe hitting the wrong path returns 404 and
   the app logs it like any other request.
3. Check the probe's path and port against what the app actually serves. A
   liveness or readiness probe pointed at a renamed endpoint is a deploy bug,
   not a platform failure — and it is the demo scenario this platform ships.

If the probe path changed in a recent commit, this is a bad deploy: go to
`bad-deploy-rollback.md` and revert it. Do not "fix" it by editing the probe in
the live deployment.

## A rollout, not an outage

A deployment mid-rollout legitimately has fewer Ready replicas for a while.
Before calling anything broken:

```promql
kube_deployment_status_replicas_updated{namespace="demo", deployment="demo-service"}
```

If `updated` is climbing toward `spec_replicas` and no pod is in a failure
phase, the rollout is progressing and the alert will clear on its own. Say so,
say when you expect it to clear, and wait — do not roll back a healthy rollout
because it is halfway done.

Check ArgoCD (`get_application_events`) for a sync in the last few minutes to
confirm.

## Remediate

Almost always: fix the cause you named above, not this alert. There is no
remediation that belongs to `ReplicasUnavailable` itself — scaling the
deployment up to make the number go away leaves the broken pods broken and adds
more of them.

The one exception is genuine capacity: if pods are `Pending` because the node
has no room, and that is expected load rather than a leak, the fix is node
capacity or a lowered replica count. Both are gated, and both belong in git
rather than in a live edit.

## Verify

- Ready equals desired, and stays there for a full minute.
- No pod is restarting during that minute — a crashlooping pod is Ready in
  bursts, and this alert's expression deliberately averages over 30s because
  that flicker resolved it once while all three replicas were still failing.
- The alert transitions to Normal in Grafana. Wait for the transition; do not
  infer it.

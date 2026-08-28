# When the alert is wrong, not the service

**Signature.** The alert is firing and the service is fine. Or it fired,
resolved, and fired again four times in ten minutes. Or it says
`DatasourceNoData` and no metric has moved at all.

This runbook exists because the reflex — make the alert stop — is the single
most destructive thing an on-call engineer can do. An alert rule is how humans
find out the *next* incident is happening. Editing one to silence today's page
removes tomorrow's alarm too, and does it invisibly.

**You may not change an alert rule.** Not with `alerting_manage_rules`, not with
`create`, `update` or `delete`. Terraform owns Grafana's alerting config on this
platform, so even a "successful" edit would be reverted at the next apply and
would have hidden the real state in between. What you produce here is a
*proposal*, in git, that a human reads.

## Tell the three cases apart

### 1. No data

The alert fires as `DatasourceNoData` or `Error`. Nothing is above threshold
because nothing is being reported at all.

An empty result usually means **healthy** on this platform — no 5xx, no OOM
kills, no restarts. Rules here are written with `no_data_state = "OK"` for
exactly that reason. So a no-data alert means either the rule is missing that
setting, or the metric pipeline genuinely stopped.

Distinguish them before you conclude anything:

```promql
up{namespace="demo"}
```

- `up` is 1 and the underlying series is simply absent → the query returns
  nothing because there is nothing wrong. This is a rule defect.
- `up` is 0, or absent → the target is not being scraped. **That is a real
  incident**, and a serious one: you are blind, not healthy. Investigate the
  ServiceMonitor, the pod, and the Prometheus target list before anything else.

Never treat a scrape failure as a false alarm. "No data" and "no problem" look
identical and are opposites.

### 2. Flapping

The alert cycles firing → resolved → firing. Each cycle wakes someone.

Almost always the metric is genuinely oscillating and the rule is sampling it
too eagerly. A crashlooping deployment is the classic: with backoff, the pods
spend stretches up together, so a short average dips under the threshold and the
alert resolves while nothing is fixed. That has happened here — an incident was
resolved and a postmortem written while all three replicas were still in
`CrashLoopBackOff`.

Check whether the underlying condition actually cleared, over a window several
times longer than the rule's own:

```promql
increase(kube_pod_container_status_restarts_total{namespace="demo"}[30m])
```

If restarts are still climbing, **the incident is not over** regardless of what
the alert says. Say so explicitly and keep working. The alert being green is not
evidence.

`for` controls how quickly a rule fires. `keep_firing_for` controls how sure it
has to be that the condition is over. Flapping on recovery is a
`keep_firing_for` problem, not a threshold problem.

### 3. Threshold genuinely wrong

The metric is real, the rule reads it correctly, and the number is simply not
where it should be — too tight and it pages on normal variance, too loose and it
misses real degradation.

This is the hardest case to be honest about, because "the threshold is wrong" is
also what an engineer says when they do not want to investigate. You need
evidence: the metric's normal range over days, not minutes, and a specific
account of what the current threshold does and does not catch.

## What to produce

Whichever case it is, the output is the same shape: a pull request against the
Terraform that owns the rule, plus a plain statement in the incident thread.

1. Read the current rule with `alerting_manage_rules` (`operation: "list"` or
   `"get"` — these are reads and are ungated; nothing else on that tool is
   permitted).
2. Find the rule in `demo-env/terraform/alerts.tf`.
3. Open a PR changing the HCL, with `terraform plan` output attached, exactly as
   `bad-deploy-rollback.md` describes for a manifest change.
4. In the PR body, state the evidence, and state what the rule will now miss.
   Every loosened alert trades sensitivity for quiet, and the reviewer is
   approving that trade — make it visible rather than burying it.

If you are not confident enough to write that trade-off down, you are not
confident enough to change the rule. Report the observation and leave it alone;
a noted-but-unfixed noisy alert is a much smaller problem than a silently
widened one.

## Verify

There is nothing to verify in the cluster — you changed no running system. What
you confirm instead:

- the underlying condition really is what you said it was, checked over a long
  window rather than the alert's own
- the PR is open, has the plan attached, and is waiting on a human
- the incident thread says which of the three cases this was, and whether the
  service was ever actually affected

# Bad deploy → rollback

**Signature.** Any alert whose start time lands within ~15 minutes after an
ArgoCD sync. This is the most common incident shape and the cheapest to fix.

## Establish the correlation before acting

1. ArgoCD MCP — the application's sync history: revision, timestamp, who
   triggered it, and current health.
2. Compare the alert's `startsAt` (from the Grafana rule state) with the sync
   timestamp. State the gap in minutes in your report — "errors began 4 minutes
   after sync `abc1234`" is the evidence; "a deploy went out recently" is not.
3. GitHub MCP — what was in that revision. A one-line config change and a
   thousand-line refactor call for different levels of confidence.

If the alert predates the sync, this runbook does not apply. Do not roll back a
deploy that is innocent: you will lose the real cause and cause a second
incident.

## Roll back

This is a production change and is gated. Before requesting approval, state:

- the revision you are rolling back **from** and **to**,
- the correlation evidence and the gap in minutes,
- what you expect the alerting metric to do, and by when,
- what is lost by rolling back (a feature, a fix, a migration — check whether the
  bad revision contained a schema migration, because those do not roll back
  cleanly and need a human decision).

Then use the ArgoCD MCP to sync to the previous healthy revision. Watch the
rollout: pods must actually become Ready on the old revision.

## After the rollback

- The offending revision is still on the main branch and will be redeployed by
  the next sync unless someone acts. Open a PR that reverts it, or a GitHub issue
  that explains the fault — and say clearly in your report which you did.
- Record the revision pair in the postmortem timeline.

## Verify

The alerting expression crosses back under its threshold and stays there for the
rule's `for:` duration. If it does not within roughly two minutes of pods going
Ready on the old revision, the deploy was not the cause: go back to
investigating, and say so.

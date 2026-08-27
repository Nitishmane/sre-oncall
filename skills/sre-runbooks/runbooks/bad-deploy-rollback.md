# Bad deploy → revert pull request

**Signature.** Any alert whose start time lands within ~15 minutes after an
ArgoCD sync. This is the most common incident shape and the cheapest to fix.

A common variant: the container is healthy but the *manifest* is wrong — a
renamed probe path, a bad port, a changed env var name. The pod restarts every
`periodSeconds` and lands in CrashLoopBackOff while the application logs look
completely normal. Read the probe definition, not just the logs.

## Establish the correlation before acting

1. ArgoCD MCP — the application's sync history: revision, timestamp, who
   triggered it, and current health.
2. Compare the alert's `startsAt` (from the Grafana rule state) with the sync
   timestamp. State the gap in minutes in your report — "errors began 4 minutes
   after sync `abc1234`" is the evidence; "a deploy went out recently" is not.
3. GitHub MCP — what was in that revision (`list_commits`, `get_file_contents`).
   A one-line config change and a thousand-line refactor call for different
   levels of confidence.

If the alert predates the sync, this runbook does not apply. Do not revert a
deploy that is innocent: you will lose the real cause and cause a second
incident.

## Revert it as a pull request

**Do not roll back through the ArgoCD MCP, and do not `kubectl` the manifest
back.** The application syncs automatically from `main`, so anything you change
cluster-side is undone at the next sync — and worse, it erases the symptom while
the cause is still committed. The fix has to land in git.

1. `create_branch` from the deploy branch, e.g. `revert/<short-sha>`.
2. `create_or_update_file` to restore exactly the lines the bad commit changed,
   taking the previous content from `get_file_contents` at the last good
   revision. Nothing else — a revert PR carrying unrelated tidying does not get
   merged during an incident.
3. `create_pull_request` against the deploy branch, with a body that stands on
   its own:
   - the revision you are reverting **from** and **to**,
   - the correlation evidence and the gap in minutes,
   - the specific line that broke it, and why that line has this effect,
   - what you expect the alerting metric to do, and by when,
   - what is lost by reverting (a feature, a fix, a migration — check whether
     the bad revision contained a schema migration, because those do not revert
     cleanly and need a human decision).

Then post the PR link and the same reasoning into the incident thread, and stop.
**A human reviews and merges it. That merge is the approval.** Do not merge it
yourself and do not ask to.

## Verify, after the merge

ArgoCD syncs the merge automatically. Watch that pods become Ready on the
reverted revision — and keep watching: a container killed by a failing probe is
Ready for a few seconds at a time, so a single Ready reading proves nothing.

The alerting expression must cross back under its threshold and stay there for
the rule's `for:` duration. If it does not within roughly two minutes of a
successful sync, the deploy was not the cause: say so and go back to
investigating.

## Record

Put the revision pair, the PR link, and who merged it in the postmortem
timeline. The revert is now the deployed state, so the original change needs a
follow-up before anyone re-lands it — say that explicitly.

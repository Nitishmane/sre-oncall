# Postmortem format

Published as a page in the Notion **Postmortems** database via the Notion MCP.
Set every database property; an incomplete row is useless for later analysis.

## Properties

| Property | How to fill it |
|---|---|
| Incident | `<AlertName> — <one-line symptom>` |
| Date | The date the alert first fired (not when you wrote this) |
| Severity | SEV1 total outage · SEV2 major degradation · SEV3 partial//degraded · SEV4 minor or self-healed. Justify the choice in the body |
| Status | `Draft` when you publish — a human moves it to `Reviewed` |
| MTTR | Minutes from `startsAt` to the alert returning to Normal |
| Root cause | One short phrase, e.g. "memory limit lowered by deploy abc1234" |

## Page body

```
## Summary
<Three or four sentences. What broke, who was affected, how long, what fixed it.
 Written for someone who was asleep and has not read the thread.>

## Timeline
| Time (UTC) | Event | Source |
|---|---|---|
| 10:02 | ArgoCD synced demo-service to abc1234 | ArgoCD MCP |
| 10:06 | First OOMKill on demo-service-7f8c | Loki, kubernetes-events |
| 10:08 | Alert HighErrorRate fired | Grafana alert state history |
| … | … | … |

## Root cause
<The mechanism, not the trigger. "A deploy went out" is a trigger; "the deploy
 lowered the memory limit below the steady-state working set" is a cause. If the
 cause is still unknown, say so and list what was ruled out and how.>

## Detection
<Which alert fired, how long after the fault began, and whether that was fast
 enough. If detection lagged the fault by a lot, that is itself a follow-up.>

## Resolution
<What was done, who approved it, and when the metric recovered.>

## What went well / What was hard
<Two short lists. Be specific and blameless: name systems and gaps, never people.>

## Follow-ups
| Action | Why | Owner |
|---|---|---|
| <concrete, verifiable action> | <the gap it closes> | unassigned |
```

Rules:

- Every timeline row cites its source, because facts from live `get_events` and
  facts from Loki have different reliability after an hour.
- MTTR is computed from timestamps you retrieved, never estimated. Prefer
  Grafana's own alert state history. If it disagrees with, or has aged out
  and lacks, the `incident_started_at` / `incident_resolved_at` you were
  given in the prompt, say so and use the given values — they were captured
  by the orchestrator at the moment the webhook fired, so they don't depend
  on Grafana's history retention. `healing_started_at` has no Grafana
  equivalent at all (it is this platform's own session start, not an alert
  event) — use it for the response-time part of the timeline, not for MTTR.
- Follow-ups are actions, not aspirations. "Add an alert on working-set memory
  above 80% of limit" is an action; "improve memory monitoring" is not.
- Blameless: describe what the system allowed, not who did it.

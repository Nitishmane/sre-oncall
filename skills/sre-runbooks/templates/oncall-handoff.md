# On-call handoff format

Written at shift change, or on request. The reader is about to become
responsible for everything in it, and has not been watching.

```
HANDOFF — <period covered, in UTC>

STILL FIRING
  <alert> — since <time>, <what is known>, <what the next person should do>
  (or: nothing)

HEALED THIS SHIFT
  <alert> — <duration>, <cause>, <fix>, postmortem: <Notion link or "pending">

WATCH THIS
  <anything that recovered on its own, flapped, or is trending toward a
   threshold without having crossed it — with the metric and current value>

SUPPRESSED
  <any Grafana silence still in effect, what it hides, and when it expires>

OPEN FOLLOW-UPS
  <follow-up actions from recent postmortems that are still unassigned>

QUIET
  <systems that had no incidents — one line, so the reader knows they were
   actually checked rather than forgotten>
```

Rules:

- Build it from retrieved data: Grafana alert state history for the window, the
  orchestrator's incident list, and the Notion Postmortems database.
- An active silence is the single most dangerous thing to omit — a silenced
  alert looks exactly like a healthy one.
- Anything you say is unknown, say is unknown. The next person will act on this.

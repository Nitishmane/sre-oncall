# Demo script (~3 minutes)

## Status, stated plainly

This script assumes a working model provider. As of this writing the project has
**not completed a single real healing session**: there is no funded model-provider
key in this environment (`OPENAI_API_KEY`, per `SRE_ONCALL_MODEL=openai/gpt-5-6-sol`), so `npm run provision` either skips model-provider
registration or a turn against the harness fails on the model call itself. The
orchestrator, the admission policy, the concurrency control, the trust
boundary, the Slack approval-gate plumbing, and the console's auth wall are all
built and unit-tested (66 tests across `orchestrator/test/` and `web/test/`),
and pieces of them have been exercised against a live harness and a live kind
cluster (see `docs/technical-writeup.md` for exactly what was verified and
what wasn't). What has **not** been exercised is the model actually
investigating an alert and proposing a fix, because that costs real API calls
this environment doesn't have credit for.

Two ways to record, in order of preference:

- **Plan A** — get an OpenAI key with credit before recording, run
  `npm run provision`, and record the full script below as written. Every beat
  in it becomes true.
- **Plan B** — record without a working model provider. Beats 1–3 and 6 still
  work exactly as scripted (webhook, policy, session creation, console auth).
  Beat 4 (investigation) and 5 (the fix's approval) cannot show a real
  investigation; narrate over the Slack thread showing the session started and
  then failing on the model call, and instead demonstrate the approval gate
  mechanically — trigger one by hand (see "Faking an approval gate" below) so
  judges see the real Block Kit UI, the real atomic-claim logic, and the real
  audit log, even though no live agent produced that particular tool call.

Do not claim in the recorded narration that a fix was applied and verified if
Plan B is what got recorded. Say what's real: "the pipeline and the approval
gate are live; the model call in this recording didn't have credit behind it."

## Pre-flight checklist

Run through this before every rehearsal. Everything below must be true before
you hit record.

- [ ] `kind get clusters` shows `sre-oncall`
- [ ] `kubectl -n demo get pods` shows `demo-service` and `traffic-generator`
      Running, and `kubectl -n monitoring get pods` shows Prometheus/Grafana/
      Alertmanager Running
- [ ] Grafana reachable: `curl -sf http://localhost:3000/api/health`
- [ ] ArgoCD reachable (if using the deploy-correlation beat):
      `kubectl -n argocd get pods` all Running
- [ ] Orchestrator up on `:8080`: `curl -sf http://localhost:8080/healthz`
- [ ] Harness up on `:8790`: `curl -sf http://localhost:8790/api/v1/agents`
      (or `curl -sf http://localhost:8080/readyz` — checks the harness through
      the orchestrator)
- [ ] MCP bridges up on `8100`–`8104` (only the ones with credentials in
      `.env` will have started — `./mcp/bootstrap-mcp.sh` prints which):
      `for s in grafana kubernetes terraform; do curl -s -m 5 http://localhost:8790/api/v1/mcp-servers/$s/tools | jq -r '.data|length'; done`
- [ ] Agent, MCP servers and skills provisioned:
      `npm run provision` (re-run after any `.env` or `agent/agent.ts` change)
- [ ] Console up on `:3100` (only needed for the auth-wall beat):
      `npm run dev:web`, then load `http://localhost:3100` in a browser
      profile that is signed out of GitHub, or an incognito window
- [ ] Slack app connected (if using the Slack beat): the bot shows Online in
      the workspace's member list
- [ ] `demo-env/scripts/heal-reset.sh` has been run since the last rehearsal —
      steady state, no fault active
- [ ] Screen recording area set up: terminal (readable font, ~16pt), Grafana
      tab, Slack tab or console tab, browser tab for the console sign-in — in
      the order you'll actually cut to them

## Faking an approval gate (Plan B only)

If there's no live model call to produce one, the approval-gate audit trail
and Block Kit UI can still be shown honestly as *the real mechanism, exercised
directly* rather than end-to-end. From a second terminal, use the orchestrator
SDK the same way `submitApproval` does, or simply point the camera at
`orchestrator/test/approvals.test.ts` running (`npm test`) while narrating what
each assertion proves: the atomic claim, the audit-before-display ordering, the
double-click guard. This is not a substitute for Plan A — say so on camera.

## Timed script

Target: 3:00. Each beat lists the terminal/UI state, the spoken line, and the
cut point.

### 0:00–0:15 — Cold open: what this is

**Screen:** `index.html` landing page, or the README's pipeline diagram.

**Say:** "SRE-Oncall is an on-call engineer built on the TrueForge harness. A
Grafana alert fires, the agent investigates the live cluster over MCP,
proposes the smallest fix, and stops — every mutation waits for a human to
approve it."

### 0:15–0:35 — Break something

**Screen:** terminal.

**Command:**
```bash
./demo-env/scripts/inject-fault.sh errors
```

**Say (while it runs):** "This flips an error-rate flag in the demo service and
restarts its rollout — a real Kubernetes deploy, not a mocked event."

**Cut to:** `kubectl -n demo get pods -w` briefly, showing the rollout.

### 0:35–1:00 — The alert fires

**Screen:** Grafana alert list (`http://localhost:3000/alerting/list`), or the
orchestrator log tail.

**Say:** "Prometheus scrapes the error rate, the Grafana rule crosses
threshold, and its webhook contact point posts straight to the orchestrator on
the host — no tunnel, because Grafana runs in the cluster and the orchestrator
runs on the same machine."

**Show:** the orchestrator log line `webhook accepted` / `session created`, or
`curl -s localhost:8080/healthz | jq`.

**Say:** "The orchestrator checks the bearer, dedups by fingerprint, and only
passes the agent an alert rule UID and a fingerprint — never the raw alert
text. The agent re-fetches the real alert itself through the Grafana MCP.
That's deliberate: anyone who can name a Kubernetes object can write into an
alert's labels."

### 1:00–1:20 — The session starts (Slack or console)

**Screen:** Slack incident channel, or the console at `localhost:3100`.

**Say:** "The healing session shows up here, threaded, with a status line that
updates as the agent works."

*(Plan A: show the status line changing — "Running `grafana.query_prometheus`…"
then "Running `kubernetes.pods_log`…". Plan B: show the session announced, then
narrate that the model call itself needs a funded key that this environment
doesn't have, and cut to the next beat.)*

### 1:20–1:55 — The approval gate

**Screen:** Slack Block Kit message, or the console's approval panel.

**Say:** "Every write anywhere — a Kubernetes patch, an ArgoCD rollback, a
Terraform apply, a merged PR — is gated. The harness pauses the turn and shows
the exact tool and its arguments. Nothing proceeds without a human clicking
Approve."

**Show:** the Approve/Deny buttons, and click Approve.

**Say:** "That decision is written to an audit table before it's even shown, so
the record survives if Slack goes down, and it's claimed atomically — two
people can't both click at once and have it go through twice."

*(This is the single most important beat — safety controls and human approval
gates are one of the six judging criteria. Do not cut it short.)*

### 1:55–2:20 — Recovery

**Screen:** Grafana dashboard (error-rate panel), or
`./demo-env/scripts/heal-reset.sh` if simulating recovery.

**Say:** "Once the fix lands, the metric recovers and the Grafana alert
resolves on its own — the orchestrator doesn't poll for that, Grafana tells it."

### 2:20–2:45 — Postmortem

**Screen:** Notion Postmortems database (if configured), or the
`skills/sre-runbooks/templates/postmortem.md` template plus the postmortem
prompt in `orchestrator/src/prompts.ts`.

**Say:** "On resolve, a second session reconstructs the timeline from Grafana's
state history, the Kubernetes event log, and ArgoCD's sync history, and writes
it to a Notion database — this is the artifact a real on-call rotation keeps."

*(If Notion isn't wired up for the recording, say so and show the template
instead of implying a page appeared.)*

### 2:45–3:00 — The console and the close

**Screen:** `localhost:3100`, signed out, then the GitHub OAuth prompt.

**Say:** "The chat console can start harness sessions on a live cluster, so
it's never public — GitHub OAuth plus an allowlist that fails closed, and the
browser never sees the tunnel or its token. That's SRE-Oncall: an alert, an
investigation over real MCP tools, a gated fix, and a written record — built
on TrueForge."

**End card:** repo URL.

## Reset procedure between rehearsals

```bash
./demo-env/scripts/heal-reset.sh          # clears the fault, waits for rollout
# confirm the alert actually resolved before the next take:
curl -s http://localhost:3000/api/alertmanager/grafana/api/v2/alerts \
  | jq '[.[] | select(.status.state=="active")] | length'   # expect 0

# if a session got stuck mid-approval and you want a clean slate:
rm -f .data/incidents.db*                 # orchestrator restart re-creates it
# (only between rehearsals — this is the incident/approval audit history)
```

Restart the orchestrator after clearing `.data/` so it picks up a fresh store.
Leave the kind cluster, Grafana, and the harness running between takes — only
the fault and the incident store need resetting.

## What's genuinely demoable right now vs. blocked

| Beat | Status |
|---|---|
| Fault injection → real Kubernetes rollout | Works. Scripted, run repeatedly during development. |
| Grafana alert firing on the injected fault | Works, assuming `setup-grafana.sh` has applied the Terraform alert rules. |
| Webhook → orchestrator (bearer check, dedup, trust boundary) | Works and is unit-tested (`orchestrator/test/payload.test.ts`, `filter` tests in `pipeline.test.ts`). |
| Harness session/turn creation | Works — this is a plain API call and doesn't need model credit to succeed. |
| Agent actually investigating over MCP tools and proposing a fix | **Blocked.** Needs a funded model-provider key. Never observed completing in this environment. |
| Approval gate UI + atomic audit log | The mechanism is built and unit-tested (`orchestrator/test/approvals.test.ts`); triggering one from a *real* agent decision is blocked on the same model credit. |
| Metric recovery → alert auto-resolve → postmortem session | Postmortem session creation only fires once a healing session recorded a `healing_session_id` — which requires a completed healing run. Blocked transitively. |
| Notion postmortem page | Code path exists (`mcp/README.md` lists the bridge); never verified against a real Notion database in this project. |
| Slack incident threads + Block Kit approvals | Code and unit tests exist; never verified against a live Slack workspace in this project. |
| Console auth wall (OAuth + allowlist, proxy) | Verified locally: unauthenticated requests get 401/redirect, as claimed in the commit that added it. Not yet deployed to Vercel. |
| ArgoCD / Terraform MCP bridges | Verified reachable from a live harness (`grafana 65 tools, kubernetes 20, terraform 9` per `mcp/README.md`); ArgoCD and Notion bridges were not part of that verification pass. |

If Plan A doesn't materialize before the recording deadline, cut the script to
the beats marked "Works" above, be explicit on camera that the investigation
step is the part still pending a funded key, and let the approval-gate tests
carry that judging criterion instead of a live click.

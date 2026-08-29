# Demo script (~3 minutes)

## Status, stated plainly

The full script below is recordable as written. The healing loop has been run
end to end against the live cluster with a funded model provider
(`SRE_ONCALL_MODEL=openai/gpt-5-6-terra`, routed through `npm run model-proxy`,
which absorbs the 429s the harness does not retry): a bad release breaks a
liveness probe, the alert fires, the agent correlates it to the ArgoCD sync and
the offending commit, opens a revert pull request carrying its reasoning, a
human merges, ArgoCD syncs, the alert resolves, and the agent posts the
resolution summary in the same Slack thread.

Two things to be accurate about on camera:

- **Git-backed skills do not install on this host.** The runbooks are read out
  of git through the `raw-file` MCP server instead. If you show a runbook being
  consulted, that is the mechanism — do not call it a skill load.
- **Approval gates are tool-name-scoped.** Several safety rules are prompt
  instructions rather than access controls. Worth one sentence if the narration
  touches on safety, because a judge who notices it and was not told will
  discount everything else.

Do not overstate the scale. It is one service in a kind cluster with synthetic
traffic. The failure modes are real; the environment is a demo.

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
- [ ] Both Slack bots connected: `npm run dev:orchestrator` logs two
      `slack app connected` lines with distinct `bot` fields. Each bot must be a
      member of its own channel and **not** the other's, or both answer at once
- [ ] The explainer page open in a tab if you plan to close on it:
      https://trueforge-agents.vercel.app
- [ ] `demo-env/scripts/heal-reset.sh` has been run since the last rehearsal —
      steady state, no fault active
- [ ] Screen recording area set up: terminal (readable font, ~16pt), Grafana
      tab, Slack tab, GitHub tab for the pull request — in the order you'll
      actually cut to them
- [ ] `npm run model-proxy` running on :8120 — without it every turn dies on the
      model call
- [ ] ArgoCD MCP bridge answering — it has been seen timing out, and the
      correlation beat depends on it

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

**Screen:** Slack incident channel, threaded under the alert.

**Say:** "The healing session shows up here, threaded, with a status line that
updates as the agent works."

*(Show the status line changing — "Running `grafana.query_prometheus`…", then
"Running `kubernetes.pods_log`…", then "Running `argocd.get_application_events`…".
That sequence is the whole argument: it is the agent choosing tools, not a
script replaying them.)*

### 1:20–1:55 — The approval gate

**Screen:** the Slack Block Kit approval message.

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

### 2:45–3:00 — The second agent, and the close

**Screen:** Slack `#automation-agent` — a mention, the approval prompt naming
`n8n-tools.list_automations`, the approve click, and the answer landing in the
thread.

**Say:** "There are two agents, not one. This second one builds and runs n8n
automations — and it shares no tools with the on-call agent, so it cannot reach
the cluster at all. Same harness, same approval gates, different blast radius.
That's TrueForge Agents: an alert, an investigation over real MCP tools, a fix a
human merges, and a written record."

**End card:** https://trueforge-agents.vercel.app and the repo URL.

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

## What is demoable, and what is not

| Beat | Status |
|---|---|
| Fault injection → real Kubernetes rollout | Works. Scripted, run repeatedly. |
| Grafana alert firing on the injected fault | Works, once `setup-grafana.sh` has applied the Terraform alert rules. |
| Webhook → orchestrator (bearer check, dedup, trust boundary) | Works, unit-tested (`payload.test.ts`, `pipeline.test.ts`). |
| Harness session/turn creation | Works. |
| **Agent investigating over MCP tools and opening a revert PR** | **Verified end to end** against the live cluster with a funded provider. |
| **Human merges the PR → ArgoCD syncs → alert resolves** | **Verified.** The merge is the approval gate; the agent cannot merge. |
| **Approval gate UI + atomic audit log** | **Verified** against a live Slack workspace — real Block Kit, real approver-list check, real single-claim guard. |
| **Two Slack bots, channel-scoped** | **Verified.** Two apps, two Socket Mode connections; each is a member of its own channel and not the other's. |
| **n8n workflow triggered from an agent through an approval gate** | **Verified.** The workflow executes in n8n and returns live instance state. |
| Metric recovery → alert auto-resolve → postmortem session | Works; the postmortem path is the least-exercised of the verified set. |
| Notion postmortem page | The bridge attaches and answers. Fewer real executions than the revert flow — do not lean on it as the closing beat. |
| MCP bridges | All attach to a live harness and answer. The ArgoCD bridge has been seen timing out; check it in pre-flight. |
| Git-backed skills | **Do not install on this host.** Runbooks come through the `raw-file` MCP server. Say so if it comes up. |

Record the beats marked verified. If the ArgoCD bridge is down at record time,
that breaks the correlation step — check it before you start rather than
discovering it mid-take.

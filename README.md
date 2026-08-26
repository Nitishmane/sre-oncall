# SRE-Oncall

An AI on-call engineer built on the [TrueForge](https://trueforge.dev) agent
harness. A Grafana alert fires; the agent investigates the live cluster, proposes
the smallest safe fix, waits for a human to approve it, applies it, verifies that
the metric actually recovered, and writes the postmortem.

Built for the WeMakeDevs **Agent Harness** hackathon (Aug 24–30, 2026).

> ⚠️ Everything here runs against a local demo cluster. The agent is read-only by
> default; every mutation stops at an approval gate.

## The pipeline

```
inject fault ─► demo-service metrics ─► Prometheus ─► Grafana alert rule
                                                            │ webhook (bearer)
                                                            ▼
                                              orchestrator :8080
                                       verify · dedup · flap-delay · rate-limit
                                                            │ TrueForge SDK
                                                            ▼
                                              TrueForge harness :8790
                              agent investigates ─► proposes fix ─► ⏸ APPROVAL
                                                            │
                                    applies ─► verifies metric ─► alert resolves
                                                            │
                                              postmortem ─► Notion
```

Grafana runs inside the cluster and posts to the orchestrator on the host, so the
alert path never leaves the machine. The single ngrok tunnel is reserved for the
authenticated chat console, and terminates at the orchestrator's `/chat` proxy —
never at the harness itself, which has no login in local mode.

## Layout

| Path | What it is |
|---|---|
| `orchestrator/` | The webhook receiver and session broker. Verifies alerts, applies admission policy, starts harness sessions, proxies the chat console. |
| `agent/` | The SRE-Oncall agent definition: system prompt, MCP attachments, approval policy, and an idempotent provisioning script. |
| `skills/sre-runbooks/` | Runbooks per failure signature, plus the triage-report, postmortem and handoff formats. Loaded by the harness as a git-backed skill. |
| `mcp/` | Local stdio→HTTP bridges for the MCP servers the harness can only reach over a URL. |
| `demo-env/` | kind cluster, the fault-injectable demo service, Grafana alert rules, and the inject/reset scripts. |
| `index.html` | The public architecture explainer. Static, and deliberately unable to invoke anything. |

## Running it

Requires Node 22+, Docker, kind, kubectl, and helm.

```bash
cp .env.example .env      # then fill it in; .env is gitignored
npm install

# 1. the demo cluster: kind + kube-prometheus-stack + ArgoCD + demo-service
./demo-env/scripts/bootstrap.sh

# 2. Grafana alert rules and the webhook contact point
./demo-env/scripts/render-grafana-config.sh

# 3. the MCP bridges (only those whose credentials are in .env start)
docker compose -f mcp/compose.yaml --env-file .env up -d

# 4. the harness, then the orchestrator
npx @truefoundry/trueforge          # :8790
npm run dev:orchestrator            # :8080

# 5. register the agent, its MCP servers, and its skills
npm run provision

# 6. break something
./demo-env/scripts/inject-fault.sh errors
```

`inject-fault.sh` takes `errors`, `latency`, `leak`, or `crash`. Each maps to one
alert rule and one runbook. `heal-reset.sh` returns the service to steady state,
which resolves the alert and triggers the postmortem session.

## Design notes

**Alert text is untrusted.** Anyone who can name a Kubernetes object can write
into an alert's labels. The orchestrator passes the agent an alert rule UID and a
fingerprint — nothing else — and the agent re-fetches the real alert through the
Grafana MCP. Identifiers are shape-validated before they are used at all;
annotations and label values never enter a prompt. See
`orchestrator/src/prompts.ts` and the tests in `orchestrator/test/payload.test.ts`.

**Two bearers, never interchangeable.** The Grafana webhook and the chat bridge
carry different tokens and are checked separately, so a leaked webhook token
cannot drive the harness.

**Alert storms are survivable.** Work for one fingerprint is serialized on a
promise chain — a `firing` and its `resolved` can't race — and a global semaphore
caps concurrent sessions. Repeat alerts are dropped by a per-incident cooldown,
and an hourly limit bounds the worst case. Flap-prone rules are held briefly and
dropped silently if they self-resolve.

**Approval gates are structural.** Every MCP attachment declares
`requireApprovalForTools`, so the harness pauses the turn rather than the agent
choosing to ask. Tools that page a human (`n8n-tools`) are gated in full.

## Prior art

The concurrency model, trust boundary, and prompt-framing discipline are ported
from a production internal Slack SRE agent; the anonymized analysis is in
`research/reference-agent-analysis.md`.

## AI assistance

This project was built with AI coding assistants, as the hackathon rules permit
and require to be disclosed. See `docs/ai-assistance.md`.

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
alert path never leaves the machine. Nothing is exposed publicly: the Slack bots
connect outbound over Socket Mode, and the only deployed artefact is a static
explainer page that can invoke nothing.

## Status

**Verified end to end against a live harness and a live kind cluster:**

- the GitOps healing loop — a bad release breaks a liveness probe, the alert
  fires, the agent correlates it to the ArgoCD sync and the offending commit,
  opens a revert pull request carrying its reasoning, a human merges, ArgoCD
  syncs, the alert resolves, and the agent posts the summary in the same Slack
  thread
- both Slack bots, as two separate apps on two Socket Mode connections, each
  scoped to its own channel, with Block Kit approval gates decided by a named
  approver list
- the n8n path: agent → approval gate → MCP Server Trigger → a workflow that
  actually executes and returns live instance state
- MCP connectivity across Grafana, Kubernetes, ArgoCD, Terraform, GitHub,
  Notion and both n8n servers

102 automated tests cover the admission policy, concurrency control, the trust
boundary, the approval audit log's atomic-claim behaviour, and the event
translator.

**Known gap:** git-backed skills do not install on this host — the harness
materialises them inside a sandbox whose filesystem policy denies a path
`xcode-select` needs. Rather than pretend otherwise, the runbooks are read out
of git through the `raw-file` MCP server and the routing tables live in the
prompts. The skill definitions are correct and stay in the repo; on a host where
the sandbox works, re-attaching them is a one-line change.

`web/index.html` states the full real-versus-scaffolding split.

## Layout

| Path | What it is |
|---|---|
| `orchestrator/` | The webhook receiver and session broker. Verifies alerts, applies admission policy, starts harness sessions, and runs both Slack bots. |
| `agent/` | Both agent definitions — SRE-Oncall and Automation-Engineer: system prompts, MCP attachments, approval policy, and an idempotent provisioning script. |
| `skills/sre-runbooks/` | Runbooks per failure signature, plus the triage-report, postmortem and handoff formats. Loaded by the harness as a git-backed skill. |
| `mcp/` | Local stdio→HTTP bridges for the MCP servers the harness can only reach over a URL. |
| `demo-env/` | kind cluster, the fault-injectable demo service, the ArgoCD application, the Terraform-managed alerting config, and the inject/reset scripts. |
| `web/` | The public explainer page deployed to Vercel: which agent runs on what, which tools, where the gates are. Static, no build step, no secrets, and deliberately unable to invoke anything. |

## Running it

Requires Node 22+, Docker, kind, kubectl, and helm.

```bash
cp .env.example .env      # then fill it in; .env is gitignored
npm install

# 1. the demo cluster: kind + kube-prometheus-stack + ArgoCD + demo-service
./demo-env/scripts/bootstrap.sh

# 2. Grafana alerting (Terraform) and ArgoCD wiring
./demo-env/scripts/setup-grafana.sh    # mints a token, applies demo-env/terraform
./demo-env/scripts/wire-argocd.sh      # demo-service as an ArgoCD Application

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

The Slack bot starts with the orchestrator when `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` are set — see `docs/slack-setup.md` for the app manifest,
scopes, and how to restrict who may approve remediation. Without those tokens
the pipeline runs headless.

`inject-fault.sh` takes `errors`, `latency`, `leak`, or `crash`. Each maps to one
alert rule and one runbook. `heal-reset.sh` returns the service to steady state,
which resolves the alert and triggers the postmortem session.

## Code-review skills

`skills-lock.json` pins the Qodo review skills this repo uses. They are **not**
committed — restore them with:

```bash
npx skills experimental_install     # from skills-lock.json
# or, to add them fresh:
npx skills add qodo-ai/qodo-skills/skills
```

They live in `.agents/skills/` (gitignored) because they are someone else's
source: tracked, they dominated the pull-request diff and Qodo spent two whole
reviews reporting findings against its own skill files instead of this project's
code.

## Changing the model

The model is configuration. `SRE_ONCALL_MODEL` is a `provider/model` FQN whose
provider half decides which provider gets registered on the harness and which
API key is read:

```bash
SRE_ONCALL_MODEL=openai/gpt-5-6-luna       # + OPENAI_API_KEY  (the default)
SRE_ONCALL_MODEL=openai/gpt-5-6-sol        # + OPENAI_API_KEY  (stronger, 20x the output price)
SRE_ONCALL_MODEL=anthropic/claude-opus-5   # + ANTHROPIC_API_KEY
npm run provision                          # re-run after changing it
npm run provision -- --list-models         # what this harness offers
```

Verified against a live harness with both. No code changes either way.

### Talking to an agent from the terminal

```bash
npm run ask -- automation-engineer "Call harness_selftest with input 'hello'"
npm run ask -- sre-oncall "What is the demo service doing right now?"
```

Prints tool calls and results as they happen. It **stops at approval gates** and
names what it was asked to approve, which is usually the thing you wanted to
see; `--approve` allows the pending call and resumes. Note that the harness
wraps MCP tools behind its own `call_tool`, so a gate would otherwise read
"approve call_tool?" — `ask` unwraps that to the server and tool underneath.

`n8n/workflows/harness-selftest.json` is a workflow built for exactly this: no
credentials, no external calls, and it returns a timestamp that could only have
been produced inside n8n. See `n8n/README.md`.

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

**Two Slack bots, two agents.** SRE-Oncall and Automation-Agent are separate
Slack apps with separate identities, each routing to its own agent. The on-call
bot owns the incident channel and hears about alerts; the automation bot lives
in its own channel, runs n8n workflows on request, and has no cluster access at
all. `app_mention` fires in any channel a bot is in, so each bot has an optional
channel allow-list — otherwise two bots in one room both answer. See
`docs/slack-setup.md`.

**Nothing is publicly reachable.** The deployed page is static and holds no
credentials. Both Slack bots connect outbound over Socket Mode, so there is no
inbound URL to attack, and every vendor token stays in a local `.env`.

**One owner per thing.** ArgoCD owns the workload, Terraform owns the Grafana
alerting config, and nothing owns both. That is what makes each of the agent's
two remediation paths unambiguous: a bad deploy is an ArgoCD rollback, a wrong
threshold is an HCL change with a `terraform plan` attached to the PR.

**Two agents, disjoint tools.** SRE-Oncall is woken by an alert with nobody
watching, so a blocking question is a hang and `ask_user_question` is off.
Automation-Engineer exists to be talked to, so the same setting is on and asking
is the job. They share no MCP servers: the on-call agent has the cluster, the
deploy repo and alerting; the automation agent has n8n and nothing else, so it
cannot reach production even if a requirement asks it to. Splitting them also
stops each one paying tool-schema tokens for the other's servers on every
request — the constraint that has already killed investigations at 618k tokens.

**Approval gates are structural.** Every MCP attachment declares
`requireApprovalForTools`, so the harness pauses the turn rather than the agent
choosing to ask. Tools that page a human (`n8n-tools`) are gated in full. A gate
is written to an audit table *before* it is shown, so the record survives a
Slack outage; decisions are claimed atomically, so two people clicking Approve
and Deny at the same moment cannot both submit. Read the log at
`GET /approvals?hours=24`.

## Prior art

The concurrency model, trust boundary, and prompt-framing discipline are ported
from a production internal Slack SRE agent.

## AI assistance

This project was built with AI coding assistants, as the hackathon rules permit
and require to be disclosed. See `docs/ai-assistance.md`.

## Submission materials

`docs/technical-writeup.md` (architecture and the decisions worth explaining),
`docs/demo-script.md` (the timed script for the demo video, including what's
still blocked on a missing credential), and `docs/submission-checklist.md`
(every required submission component, mapped to its current state).

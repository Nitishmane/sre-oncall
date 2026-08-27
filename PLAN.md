# SRE-Oncall — TrueForge Hackathon Project Plan

> Planning date: 2026-08-23 (day before hackathon start). Hackathon window: **Aug 24, 8:00 AM – Aug 30, 8:00 PM London time**. Pre-event planning is allowed; ALL coding must happen inside the window.
> Full research backing this plan: `research/trueforge-hackathon.md`, `research/reference-agent-analysis.md`, `research/architecture-research.md`.

## 1. Project Summary

**SRE-Oncall** is an AI on-call engineer built on the **TrueForge agent harness** (mandatory for the hackathon). It:

1. Answers SRE queries through an **authenticated chatbox** (Next.js on Vercel wrapping the TrueForge React SDK, behind a GitHub-OAuth allowlist — the chat can invoke the harness, so it is never public) and **Slack**.
2. Runs an **automated healing pipeline** when an alert fires: demo fault → Prometheus metrics → **Grafana alert rule** → webhook contact point (bearer-authenticated, local-to-local — no tunnel) → webhook orchestrator → TrueForge SDK creates a healing session → agent debugs and heals via MCP tools (Grafana, Kubernetes, ArgoCD, Terraform, GitHub), verifies the metric recovers, and the alert auto-resolves.
3. Proposes fixes behind a **human approval gate** (an explicit judging criterion), opens PRs that get **Qodo** review (required for the Best Code Quality track).
4. Generates **postmortems** on `incident.resolved` and **oncall handoff summaries** at shift change.
5. Debugs **live cluster events** via the Kubernetes MCP (events, pod logs, crash diagnostics), correlates incidents with recent deploys via the **ArgoCD MCP**, and handles infra-as-code changes via the **Terraform MCP**.

Modeled on a production internal Slack SRE agent (anonymized — see `research/reference-agent-analysis.md`) but rebuilt on TrueForge.

> **Public-event rule: this directory and the hackathon repo are public. No company names, internal hostnames, repo/channel names, or any employer data may appear in code, docs, prompts, demo video, or commits.** The reference analysis has already been anonymized — keep it that way.

## 2. Hard Hackathon Constraints (from rules)

- Agent **MUST run on TrueForge** — judges must see genuine harness work, not a thin model wrapper.
- **Qodo installed from day one** on a **public repo**, with visible PR review history (Q Branch track eligibility).
- **Human approval gates** are one of six equally-weighted judging criteria — build them in, show them in the demo.
- All coding Aug 24–30; AI coding assistants allowed but must be **disclosed**; you must be able to explain the code.
- Submission: public repo + README, ~3-min demo video, technical write-up, no API keys in repo/video.
- Register: https://forms.gle/dNHFh7wH8uJj4bZH8 · Discord: https://discord.gg/wemakedevs

**Target tracks**: Double-O (Best Use of TrueForge, NVIDIA DGX Spark) primary; Q Branch (Best Code Quality, Mac Mini) via Qodo discipline; Savile Row (Best UI, iPads) via TrueForge UI SDK chatbox. Field Report (blog) and Radio Traffic (social) are cheap add-ons at the end.

## 3. Key Decisions (reconciled across the three research reports)

| Decision | Choice | Why |
|---|---|---|
| Agent runtime | **TrueForge** (`npx @truefoundry/trueforge`, local mode, SQLite) | Mandated by rules. Provides sessions, MCP, skills, approval gates, subagents, SDK+SSE out of the box. |
| Model provider | **Anthropic Claude** (Opus for investigation, Sonnet for summaries) via TrueForge model config | Strongest multi-step tool use; Anthropic SRE cookbook maps 1:1 to our flow. (The architecture report recommended Claude Managed Agents SDK — overridden by the TrueForge mandate; its patterns still apply.) |
| Alert ingress & healing trigger | **Grafana Alerting** (kube-prometheus-stack in the kind cluster: Prometheus + Grafana + Alertmanager) → **webhook contact point** with bearer-token auth → local orchestrator `POST /webhook/grafana` → TrueForge healing session. *(Decision 2026-08-25: replaces PagerDuty entirely — no PD account, no PD MCP.)* | Alert → healing is one hop, fully local (Grafana pod → host orchestrator, no tunnel), zero SaaS trial expiry risk, and the same Grafana is already our metrics/logs MCP source. `firing` → healing session; `resolved` → postmortem session. |
| Chat surfaces | **Authenticated Next.js chatbox on Vercel** (wraps `@truefoundry/trueforge-ui`; Auth.js GitHub-OAuth with a hardcoded allowlist; all harness calls proxied server-side) + Slack bot (Bolt, Socket Mode) for triage output & approval buttons | The chat can start harness sessions, so it must not be public. Slack is the authentic SRE surface; the Next.js wrapper is required anyway once auth enters the picture (Best UI track). |
| Chatbox auth | **Auth.js (NextAuth v5) GitHub provider + username allowlist**; browser never sees the harness URL/token — Next.js route handlers check the session, then forward to `TRUEFORGE_API_URL` (ngrok) with a server-side bearer. The tunnel terminates at the **orchestrator's authenticated proxy**, never at raw TrueForge (local mode has no login). Fallback: host the chatbox as a separate Vercel project with Vercel Deployment Protection. | Two auth layers: OAuth at the page, bearer at the tunnel. TrueForge local mode exposed unauthenticated to the internet is the #1 foot-gun the TrueForge docs warn about. |
| Codebase knowledge | Reference-agent pattern: **git clone allowlisted demo repo into workspace** + repo descriptions in system prompt. No RAG. | Proven in production; trivial to demo (agent finds the bad commit / config in the demo service repo). |
| Runbooks | TrueForge **Skills** (git-backed SKILL.md packs) | Native harness feature; judges see distinctive TrueForge usage. |
| Concurrency | Session-per-incident in TrueForge; orchestrator serializes per incident-ID (promise-chain) + global cap, à la the reference agent's `concurrency.ts` | Copy the pattern from `research/reference-agent-analysis.md §c`. |
| Live k8s debugging | **Kubernetes MCP** (stdio, local kubeconfig → kind): `get_events`, pod logs, `diagnose_pod_crash`, describe/rollout — the agent's primary evidence source during triage | Agent runs locally, so stdio needs no tunnel; live events make the demo visceral. |
| Deploy correlation | **ArgoCD MCP** (akuity/argocd-mcp; `ARGOCD_BASE_URL` + API token) against ArgoCD installed in the kind cluster (port-forward — local, no ngrok needed) | "What changed recently?" is the first SRE question — agent checks app sync status/history and correlates the incident with the last deploy. |
| Infra as code | **Terraform MCP** — HashiCorp official `terraform-mcp-server` (registry/provider docs, stdio) and/or AWS Labs `terraform-mcp-server` (runs plan/validate + Checkov) | Lets the agent author correct HCL fixes and produce a reviewable `terraform plan` as a PR (behind the approval gate). If any Terraform tooling is local-HTTP-only, expose it via ngrok like any other local server. |
| Workflow automation | **n8n** (self-hosted Docker, free) via two MCP modes: **czlonkowski/n8n-mcp "builder"** (`http://localhost:3000/mcp`, bearer token — agent creates/validates/activates n8n workflows from natural-language requests) + **n8n MCP Server Trigger** (streamable-HTTP on `:5678/mcp/...` — 2-3 pre-built standing tools: notify-oncall, create-incident-ticket, escalate-incident). Mode 2 (n8n as MCP client) not used. | "Set up a workflow to…" requests become **agent-built automation** — the demo's wow moment. Agent runs locally so both endpoints are localhost, no tunnel; workflow activation and any notification sends sit behind the harness approval gate. Full detail: `research/n8n-mcp-research.md`. |
| Postmortem publish target | **Notion (SaaS)** — agent creates a page in a shared "Postmortems" database via the official Notion MCP; Slack message with the summary + page link. *(Decision 2026-08-25: Notion primary, replacing the GitHub-PR-first approach; a repo copy is optional.)* Headless-friendly setup: `npx @notionhq/notion-mcp-server` (stdio) with a Notion **internal integration token** shared to the Postmortems database — avoids the interactive OAuth flow of the hosted `mcp.notion.com`. | Notion is where real teams keep postmortems; a filled database (severity, MTTR, root cause, status) is a great judge-facing artifact. Cloud API is outbound-only from the local agent — no ngrok. Free Notion plan supports integrations. |
| Demo fault environment | Local **kind** k8s cluster running a small demo service; synthetic faults via curl to Events API v2 and/or OOM-inducing deploy | Fully controllable, offline-safe, k8s MCP works against local kubeconfig. |

## 4. Architecture

```
   Vercel: authenticated chatbox (Next.js + trueforge-ui, GitHub-OAuth
   allowlist) ── server-side proxy ──► https://<static>.ngrok-free.app
                     (bearer-authenticated) ──► orchestrator :8080
                                                      │
┌──────────────────────────── LOCAL HOST ─────────────▼──────────────────┐
│  kind cluster: demo-service (fault-injectable, ArgoCD-managed)         │
│   └─ kube-prometheus-stack: Prometheus scrapes → GRAFANA ALERTING      │
│         │ alert rule fires (error rate / OOM)                          │
│         │ webhook contact point (bearer token) → localhost:8080        │
│         ▼            — local-to-local: NO tunnel for alert ingress —   │
│  webhook orchestrator (src/orchestrator)                               │
│   • verify webhook bearer token (optional HMAC, Grafana ≥11)           │
│   • dedup by alert fingerprint/groupKey, flap-delay, rate-limit        │
│   • frame ONLY alert rule UID + fingerprint into the prompt (injection │
│     defense — agent fetches details via Grafana MCP; never raw         │
│     labels/annotations)                                                │
│   • status=firing   → create TrueForge session (healing prompt)        │
│   • status=resolved → create TrueForge session (postmortem prompt)     │
│   • cron/shift-change → handoff-summary session                        │
│   • /chat proxy: validates bearer from Vercel, forwards to TrueForge   │
│                    │ @truefoundry/trueforge-sdk (REST + SSE)           │
│                    ▼                                                    │
│  TrueForge harness (npx @truefoundry/trueforge, SQLite)                │
│   • Agent: "SRE-Oncall"  — Claude Opus/Sonnet                          │
│   • Skills: runbooks repo (SKILL.md per failure signature)             │
│   • Approval gates before ANY write/remediation                        │
│   • Subagents: parallel metrics+logs+k8s investigation                 │
│   • MCP: grafana  (local kube-prometheus-stack — alert rules, PromQL,  │
│                    Loki/logs, dashboards, silences)                    │
│          kubernetes (stdio, local kubeconfig → kind cluster:           │
│                      live events, pod logs, crash diagnostics)         │
│          argocd   (stdio/HTTP → ArgoCD in kind via port-forward:       │
│                      sync status, deploy history, rollback)            │
│          terraform (stdio — HashiCorp registry docs / plan+validate)   │
│          n8n-builder (localhost:3000/mcp — agent creates & activates   │
│                      n8n workflows: "agent-built automation")          │
│          n8n-tools  (localhost:5678/mcp/* — standing workflows:        │
│                      notify-oncall, create-ticket, escalate)           │
│          github   (api.githubcopilot.com/mcp/ — cloud)                 │
│          notion   (stdio, integration token — postmortem pages)        │
│   • Sandbox (Daytona) for diagnostic scripts & postmortem drafting     │
│                    │                                                    │
│   Slack bot (Bolt, Socket Mode): triage threads + approval Block Kit   │
└─────────────────────────────────────────────────────────────────────────┘
```

Alert ingress needs NO tunnel — Grafana runs in the kind cluster and posts its webhook to the host orchestrator (`host.docker.internal` / node-IP routing from the cluster to the host; verify on Day 2). ngrok's single free tunnel is now dedicated to the **Vercel chatbox → orchestrator `/chat` proxy → TrueForge** path, and every hop on it is authenticated (OAuth at Vercel, bearer at the tunnel). Never point the tunnel at raw TrueForge — local mode has no login. Local/stdio MCP servers need no tunnel because the agent runs locally; cloud MCPs (GitHub) are reached directly. If any tool ends up local-HTTP-only and a cloud component must reach it, expose it via Cloudflare Tunnel (free, avoids the 1-tunnel ngrok limit).

## 5. Components to Build

1. **`orchestrator/`** — small HTTP service (FastAPI or Express):
   - `POST /webhook/grafana` — verify bearer token → filter (status==firing, dedup by fingerprint/groupKey, flap-delay, max-per-hour) → create TrueForge healing session via SDK with framed prompt `"Heal Grafana alert: rule <UID>, fingerprint <FP>"` (agent pulls labels/annotations/values itself via Grafana MCP).
   - `status=resolved` handler → wait ~60s → postmortem session (includes what the healing session did).
   - `POST /chat/*` — authenticated proxy for the Vercel chatbox: validate `TRUEFORGE_BRIDGE_TOKEN` bearer → forward to local TrueForge API (REST + SSE pass-through). This is the ONLY thing the ngrok tunnel exposes.
   - `POST /slack/actions` (or Bolt listener) — approval button → resume paused TrueForge session.
   - Per-alert serialization + global concurrency cap (port `concurrency.ts` pattern from the reference agent).
2. **TrueForge agent definition** — "SRE-Oncall" agent: system prompt (adapt the reference agent's `prompts/base.md` structure: RESEARCH → INVESTIGATE → COMPOSE), MCP attachments, skills repo, approval-gate policy (any Grafana write such as silences/annotations, any k8s mutation, any PR merge, any n8n workflow activation).
3. **`skills/` repo** — SKILL.md runbooks: pod-crashloop/OOM, high-error-rate, deploy-rollback, db-connection-exhaustion + triage-report format + postmortem template + handoff template.
4. **Slack bot** — Bolt Socket Mode: @mention/DM → forward query to TrueForge session, post streamed result to thread (update-in-place status message, reference-agent style); Block Kit Approve/Reject wired to approval gates.
5. **Chatbox (`web/`)** — Next.js app on Vercel embedding `@truefoundry/trueforge-ui`, with incident timeline panel (Savile Row track). **Auth is mandatory**: Auth.js (NextAuth v5) GitHub provider + hardcoded username allowlist; middleware guards every page and API route; harness calls go through Next.js route handlers that attach the server-side `TRUEFORGE_BRIDGE_TOKEN` and forward to the ngrok URL → orchestrator `/chat` proxy. The browser never receives the tunnel URL or token. (Local-dev use of the bare TrueForge Chat UI on localhost is fine — it's not exposed.)
6. **`n8n/`** — docker-compose service pair: pinned `n8nio/n8n` (port 5678) + `czlonkowski/n8n-mcp` builder (port 3000, `N8N_API_URL`/`N8N_API_KEY`/`MCP_AUTH_TOKEN`); 2-3 exported standing workflows (JSON) with **MCP Server Trigger** entry points: `notify-oncall` (Slack + optional Twilio SMS), `create-incident-ticket` (GitHub issue + Slack thread), `escalate-incident` (timed escalation chain). Tool descriptions written like typed docstrings (routing depends on them). Always `validate_workflow` before activate; pin n8n image version (schema-drift gotcha).
7. **`demo-env/`** — kind cluster with **ArgoCD installed**; demo service deployed as an ArgoCD Application (so a "bad deploy" is an ArgoCD sync the agent can find and roll back); tunable memory limit / error-rate flag; a small **Terraform config** for demo infra (e.g. the kind/ArgoCD bootstrap or a mock module) so the agent has real HCL to modify; `scripts/inject-fault.sh` (flip the demo service's error-rate/memory flag so a real Grafana alert rule fires) and `scripts/heal-reset.sh` (restore steady state between rehearsals).
8. **Capabilities** (effort from research, in priority order):
   - Alert → healing pipeline (core: Grafana alert fires → agent debugs via live k8s events/logs → gated fix → verifies metric recovery → alert auto-resolves) — Day 1–3
   - Deploy-correlation triage: ArgoCD sync history → "this started right after sync X"; approval-gated rollback via ArgoCD MCP — ~2-3h
   - Approval-gated remediation + agent-opened PR (Qodo reviews it); remediation may be a k8s manifest fix, an ArgoCD rollback, or a **Terraform change with `terraform plan` output attached to the PR** — ~4h
   - Postmortem generation → **Notion page** (Postmortems database: title, date, severity, MTTR, root cause, timeline, follow-ups) + Slack summary with link; optional copy into the repo — ~4-5h
   - Oncall handoff summary (orchestrator incident store + Grafana alert history/annotations; if Grafana Cloud IRM is added later, the Grafana MCP oncall tools slot in) — ~3-4h
   - **Agent-built automation via n8n** (NL request → agent uses n8n-mcp builder: `search_nodes` → `get_template` → `validate_workflow` → create + activate, behind approval gate). Demo beats: "every morning post overnight-incident summary to the channel", "when a P1 fires, also SMS the EM" — ~3-4h incl. n8n setup
   - Standing n8n workflow tools (notify-oncall / create-incident-ticket / escalate-incident via MCP Server Trigger) — ~2-3h using n8n templates
   - Severity classification (agent scores blast radius from metrics and tags the incident record / Grafana annotation) — ~1-2h stretch
   - Status page post (n8n workflow → any status API or Slack #status channel) — ~1-2h stretch

## 6. Day-by-Day Schedule (Aug 24–30)

| Day | Goal |
|---|---|
| **Mon 24** | Register team. Create public GitHub repo + **install Qodo app immediately**. `npx @truefoundry/trueforge` running; Anthropic key configured; kind cluster up; agent answers a basic query via the Kubernetes MCP. First PRs (everything via PR from day one → Qodo history). |
| **Tue 25** | Alert → healing pipeline: kube-prometheus-stack helm install in kind; Grafana alert rule on demo-service (error rate / OOM); **webhook contact point (bearer) → orchestrator** (verify cluster→host routing, e.g. `host.docker.internal`); dedup/flap-delay; healing-session creation via TrueForge SDK. End-to-end: inject fault → Grafana alert fires → agent session starts. No tunnel involved. |
| **Wed 26** | Demo env + investigation depth: **ArgoCD install** + demo service as ArgoCD app; **Loki + Alloy (`loki.source.kubernetes_events`) so k8s events land in Grafana + event-based alert rules (§12)**; custom demo-service dashboard; Grafana MCP (local instance, service-account token) + ArgoCD MCP + Terraform MCP wired into the agent; skills repo with 3–4 runbooks; agent produces a real healing report (metrics + logs + pod events + last deploy). |
| **Thu 27** | Slack bot (triage threads, status updates) + approval gates (Block Kit Approve/Reject → resume session); remediation flow: agent opens fix PR → Qodo reviews → human approves → merge → metric recovers → alert auto-resolves. |
| **Fri 28** | Postmortem generation on `resolved` webhook; oncall handoff summary; **n8n up (docker) + n8n-mcp builder wired into TrueForge; standing workflows (notify-oncall, escalate) + agent-built-workflow demo rehearsed**; **chatbox on Vercel: Auth.js GitHub-OAuth allowlist + server-side proxy → ngrok → orchestrator `/chat`** (embed trueforge-ui, incident timeline). |
| **Sat 29** | Buffer + stretch goals (severity classification, status page); harden demo (reset scripts, rehearse full run twice); start demo video + write-up. (SF in-person event today if attending.) |
| **Sun 30** | Record 3-min demo video; finish README + technical write-up (disclose AI assistants); blog post (Field Report); social post (Radio Traffic); **submit well before 8 PM London**. |

## 7. Accounts / Keys Checklist (do on Day 1)

- [ ] Hackathon registration (form above) + join Discord
- [ ] Public GitHub repo created; **Qodo GitHub app installed** (free for open source): https://docs.qodo.ai/code-review
- [ ] Anthropic API key (console.anthropic.com) — verify which account, since the project moves machines
- [ ] ngrok account + authtoken + **claim free static domain** (dashboard) — used ONLY for the chatbox→orchestrator bridge; backup: `cloudflared`
- [ ] kube-prometheus-stack (helm) in kind → local Grafana; create Grafana **service-account token** (for the Grafana MCP) and a **webhook contact point** → `http://host.docker.internal:8080/webhook/grafana` with bearer-token auth; alert rule on the demo service
- [ ] GitHub OAuth App for the chatbox (callback: the Vercel URL); Auth.js `AUTH_SECRET`; decide the username allowlist
- [ ] Notion (free plan OK): create a **"Postmortems" database** (properties: Incident, Date, Severity, Status, MTTR, Root cause); create an **internal integration** (Settings → Connections) and share the database with it; token goes in `NOTION_TOKEN`
- [ ] Slack: create app (Socket Mode; bot + app tokens; scopes list in `research/reference-agent-analysis.md §e`) in a personal/new workspace you control — do NOT use your employer's workspace
- [ ] kind + kubectl installed locally; ArgoCD manifests ready to install into kind; terraform CLI installed
- [ ] Verify MCP servers run: k8s MCP (kubeconfig), akuity/argocd-mcp (base URL + token), hashicorp/terraform-mcp-server (Docker/stdio)
- [ ] n8n: `docker run -p 5678:5678 -v ~/.n8n:/home/node/.n8n n8nio/n8n` (pin version); create API key; run czlonkowski/n8n-mcp container (port 3000); optional Twilio trial account for the SMS beat
- [ ] Check whether TrueForge's Daytona sandbox needs its own account (open question #5)

### Env vars the project will need
**`.env.example` (committable template) and `.gitignore` exist in this directory** — copy `.env.example` → `.env` and fill in; `.env` is gitignored (verified). The `.gitignore` also blocks other secret-prone paths: `*.tfvars`, `*.tfstate`, `kubeconfig*`, `*.pem`/`*.key`, n8n data, SQLite files. Vercel chatbox vars are set in the Vercel dashboard only.
```bash
ANTHROPIC_API_KEY=            # model provider for TrueForge
GRAFANA_WEBHOOK_BEARER=       # bearer the orchestrator requires on POST /webhook/grafana
NGROK_AUTHTOKEN=              # tunnel (chatbox bridge only)
NGROK_DOMAIN=                 # claimed static domain
TRUEFORGE_BRIDGE_TOKEN=       # bearer the orchestrator /chat proxy requires (shared with Vercel, server-side)
GRAFANA_URL= / GRAFANA_TOKEN= # Grafana MCP → local kube-prometheus-stack Grafana, service-account token
GITHUB_TOKEN=                 # GitHub MCP (fix PRs)
NOTION_TOKEN=                 # Notion internal integration (ntn_…) — postmortem pages via notion-mcp-server
ARGOCD_BASE_URL=              # ArgoCD MCP (port-forwarded ArgoCD in kind)
ARGOCD_API_TOKEN=             # ArgoCD account token (create local account in kind ArgoCD)
N8N_API_URL=http://localhost:5678   # n8n instance (self-hosted Docker, pinned version)
N8N_API_KEY=                  # n8n Settings → API → Create API Key (full-access on community edition)
N8N_MCP_AUTH_TOKEN=           # bearer for n8n-mcp builder (openssl rand -hex 32); MCP_AUTH_TOKEN==AUTH_TOKEN in container
N8N_TOOLS_BEARER=             # bearer auth for the MCP Server Trigger standing tools
TWILIO_SID= / TWILIO_TOKEN=   # optional — SMS/call beat in notify-oncall workflow
# Terraform MCP: HashiCorp registry server needs no token; TF Cloud workspaces would need TFE_TOKEN (not planned)
SLACK_BOT_TOKEN= / SLACK_APP_TOKEN=  # Bolt Socket Mode
MAX_CONCURRENT_SESSIONS=3     # orchestrator global cap

# Vercel (chatbox project) — server-side env vars, never NEXT_PUBLIC:
AUTH_SECRET=                  # Auth.js session encryption
AUTH_GITHUB_ID= / AUTH_GITHUB_SECRET=   # GitHub OAuth App
CHAT_ALLOWLIST=               # comma-separated GitHub usernames permitted to chat
TRUEFORGE_API_URL=            # https://<static>.ngrok-free.app (orchestrator /chat proxy)
TRUEFORGE_BRIDGE_TOKEN=       # must match the orchestrator's value
```

## 8. Patterns to Port from the Reference Agent (see research/reference-agent-analysis.md)

- **Trust boundary**: only auto-heal events verified as coming from Grafana (webhook bearer token; optional HMAC on Grafana ≥11 — replaces the Slack-bot-UID check); frame ONLY the alert rule UID + fingerprint into the prompt — the agent fetches labels/annotations/values itself via the Grafana MCP; never pass raw alert text.
- **Per-incident promise-chain serialization + global semaphore** (`concurrency.ts` — copy nearly as-is).
- **Flap-delay** (hold flappy alerts N seconds; skip if self-resolved), **dedup**, **max-per-hour rate limit**.
- **Session persistence keyed by incident/thread** — TrueForge sessions replace SDK `--resume` + SQLite mapping.
- **Prompt structure**: base role prompt + per-capability playbooks (grafana.md, kubernetes.md, argocd.md) → becomes TrueForge Skills. (its pagerduty.md playbook is still the structural template — swap the API calls for Grafana MCP tools.)
- **Status-message-updated-in-place** for Slack progress; chunked posting for long outputs.
- **Read-only by default; writes only behind approval** (here: TrueForge approval gates — also a judging criterion).

## 9. Open Questions (resolve Day 1)

1. TrueForge cookbook examples — check github.com/truefoundry/trueforge for the closest template (Bring-Your-Own-MCP).
2. ~~Qodo open-source tier — confirm whether the 30 PR/month cap applies to OSS repos.~~ **Resolved 2026-08-26** (qodo.ai/pricing): there is no permanent free tier. What exists is a **14-day trial, no credit card**, which covers the whole hackathon window; paid Pro Team is $30/user/mo; the open-source programme requires an **application**, not a self-serve signup. Qodo runs fine on a **private** repo — but the rules demand *visible* PR review history and publicly readable code, so a private repo fails on **visibility, not capability**. Plan: build private, install Qodo at repo creation so review history accumulates from the first PR, flip public before submission.
3. Daytona sandbox — bundled with TrueForge local mode or separate account/key? (trueforge.dev/sandbox)
4. Qodo Command MCP mode — can a local Qodo agent register as an MCP server inside TrueForge? (If yes: agent reviews its own patches — great demo beat.)
5. Which Slack workspace to use for the demo (personal/new workspace recommended).
6. Team composition (solo or up to 4) — affects registration.
7. Which GitHub account/repo — remember the project moves to a different Claude account/machine; keep all secrets in `.env` (gitignored), never in the repo.

## 10. Demo Script

Full 10-step, ~8-minute script in `research/architecture-research.md §g` — **adapted for the PD→Grafana switch (2026-08-25)**: inject fault in demo-service → Prometheus metric crosses threshold → **Grafana alert fires** → healing session starts (visible in Slack + authenticated chatbox) → agent investigates (metrics, live k8s events, ArgoCD sync history) → approval gate → merge fix → **metric recovers, Grafana alert auto-resolves** → postmortem page appears in the Notion database (show it filling in live) → handoff summary. Extra beat: log into the chatbox via GitHub OAuth on screen — judges see the auth wall (a judging criterion is safety controls). Rehearse twice on Aug 29.

## 11. Vercel Deployment (live demo surfaces)

**Rule of thumb: Vercel serves the face; the local host runs the brain; ngrok bridges the two.**

### Deployable on Vercel
| What | When | Notes |
|---|---|---|
| `index.html` architecture/landing page (in this directory) | now | Fully static, zero-config, stays **public** — it's an explainer, it can't invoke anything. Has a **“Sign in to the SRE console” button** (status bar + hero + footer) currently pointing at the `/console` placeholder — **wire it to the deployed chatbox URL before submission** (rewrite in `vercel.json` if the chatbox is a separate project). |
| **Authenticated chatbox** (Next.js embedding `@truefoundry/trueforge-ui`) | Day 4–5 | **Not public — it can invoke the harness.** Auth.js GitHub-OAuth + username allowlist; middleware guards all pages/routes; harness calls proxied server-side with `TRUEFORGE_BRIDGE_TOKEN` to `TRUEFORGE_API_URL` (ngrok → orchestrator `/chat`). SSE passes through fine. The browser never sees the tunnel URL or token. |

### NOT deployable on Vercel (stays on the local host)
- **TrueForge harness** — long-running server, SQLite state, persistent SSE sessions; not serverless-compatible.
- **stdio MCP servers** (kubernetes, argocd, terraform) — need local kubeconfig, port-forwarded ArgoCD, local terraform CLI.
- **Slack bot** — Socket Mode holds a persistent WebSocket; Vercel functions can't.
- **kind demo cluster** + demo service.

### Integration steps
1. `npm i -g vercel && vercel login` (use the hackathon GitHub account).
2. Preferred: connect the public hackathon repo in the Vercel dashboard → auto-deploy on push, **and every PR gets a preview URL** — pairs nicely with the Qodo review on each PR (judges see review + preview per change).
3. Or one-off: `vercel --prod` from the repo root — `index.html` is served as a static site with zero config.
4. Env vars: none for the static page. The chatbox project needs server-side (never `NEXT_PUBLIC_`) vars: `AUTH_SECRET`, `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`, `CHAT_ALLOWLIST`, `TRUEFORGE_API_URL`, `TRUEFORGE_BRIDGE_TOKEN`. **Vercel holds only the auth/bridge secrets — no vendor credentials** (Grafana, GitHub-MCP, Slack, Anthropic, n8n tokens all stay on the local host).

### Chatbox authentication (mandatory — the chat can invoke the harness)
- **Layer 1 — page/API auth on Vercel:** Auth.js (NextAuth v5) with the GitHub provider; `signIn` callback rejects any GitHub username not in `CHAT_ALLOWLIST`. Next.js middleware protects every route (`/`, `/api/chat/*`); unauthenticated users get only the sign-in page.
- **Layer 2 — tunnel auth:** the ngrok URL terminates at the orchestrator's `/chat` proxy, which requires the `TRUEFORGE_BRIDGE_TOKEN` bearer (known only to the Vercel server runtime). Raw TrueForge is never tunneled — its local mode has no login.
- **Fallback (zero-code):** host the chatbox as a separate Vercel project with Vercel Deployment Protection enabled (keeps `index.html`'s project public). App-level OAuth is preferred since judges/teammates aren't Vercel team members.

## 12. Grafana Alert Catalog, Dashboards, and K8s Events Ingestion

### Alert rules
**Built-in (kube-prometheus-stack `kubernetes-mixin`, fire via Alertmanager):** `KubePodCrashLooping`, `KubePodNotReady`, `KubeContainerWaiting`, `KubeDeploymentReplicasMismatch`, `KubeJobFailed`, `KubeHpaMaxedOut`, `CPUThrottlingHigh`, `NodeMemoryHighUtilization`, `NodeFilesystemSpaceFillingUp`, `TargetDown`, `Watchdog` (heartbeat — use it Day 2 to verify the webhook path). Caveat: built-ins have slow `for:` durations (10–15m) — background coverage, not demo drivers. Route Alertmanager's webhook receiver to the same orchestrator endpoint; the Alertmanager and Grafana webhook payloads are near-identical (accept both, key off `fingerprint`).

**Custom Grafana-managed rules for demo-service (fast: 10–30s eval, 1–2m `for:`; each maps 1:1 to a runbook SKILL.md):**
| Alert | Expr sketch | Demo trigger |
|---|---|---|
| HighErrorRate | 5xx ratio > 5% for 2m | flip error-rate flag |
| HighLatencyP99 | histogram p99 > 500ms for 3m | latency flag |
| OOMKilled | `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1` | lower memory limit / leak flag |
| ContainerRestartsSpiking | `increase(kube_pod_container_status_restarts_total[10m]) > 3` | crash flag |
| PodPendingTooLong / ReplicasUnavailable | `kube_pod_status_phase{phase="Pending"}` for 5m | impossible resource request |

### Dashboards
kube-prometheus-stack auto-provisions **~30 dashboards** (K8s compute resources cluster/namespace/pod/workload, Node Exporter, Kubelet, API server, CoreDNS, networking, PVs, Prometheus health). Build **one custom demo-service dashboard** (error rate, p99, memory vs limit, restarts) — the "all-green" demo opener; the Grafana MCP panel-render tool embeds these panels as images in the Notion postmortem.

### K8s events → Grafana → healing loop (yes)
Events aren't metrics; add the log path: **Loki** (single-binary helm) + **Grafana Alloy** with `loki.source.kubernetes_events` (tails the events API → Loki). Then:
- **Grafana-managed alert rules on Loki queries** — e.g. `count_over_time({job="kubernetes-events"} |= "FailedScheduling" [5m]) > 0`, ImagePullBackOff, evictions → same webhook contact point → same healing loop. Catches event-only failures metrics never show.
- **Investigation win:** the agent queries event *history* via Grafana MCP `query_loki_logs` (live `kubectl get events` loses events after ~1h).
- Lightweight fallback when Loki feels heavy: kube-state-metrics already covers OOMKilled/restarts as metrics; `kubernetes-event-exporter` can also webhook the orchestrator directly (non-Grafana path).
- Effort: ~1–2h helm work. Slot into Wed 26 (demo-env day).

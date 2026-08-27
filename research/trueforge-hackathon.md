# TrueForge Hackathon: Comprehensive Research Report

> Source: research-analyst agent (web research, 2026-08-23).
> Purpose: vendor/tool reference for the SRE-Oncall hackathon project.

## (a) Hackathon Overview & Logistics

**Name:** The Agent Harness Hackathon (colloquially "TrueForge Hackathon")
**Organizer:** WeMakeDevs
**Page:** https://www.wemakedevs.org/hackathons/trueforge
**Rules page:** https://www.wemakedevs.org/hackathons/trueforge/rules
**Resources page:** https://www.wemakedevs.org/hackathons/trueforge/resources

**Dates:**
- Start: Monday, August 24, 2026 at 8:00 AM London time
- End: Sunday, August 30, 2026 at 8:00 PM London time
- In-person SF event: Saturday, August 29, 2026 (limited space — Luma link: https://luma.com/agent-harness)

**Format:** Online from anywhere worldwide + optional in-person in San Francisco

**Registration:** https://forms.gle/dNHFh7wH8uJj4bZH8 — free, open now

**Team size:** Solo or up to 4 people (each person may only join one team)

**Cost:** Free

**Community:** https://discord.gg/wemakedevs

---

### Prize Structure ($10,000 total)

**Judged Tracks (one track win per team maximum):**

| Track | Sponsor | Prize | Criterion |
|---|---|---|---|
| Double-O Track | TrueFoundry | NVIDIA DGX Spark (~$5,000 value) | Best Use of TrueForge |
| Q Branch Track | Qodo | Mac Mini (~$1,000) | Best Code Quality |
| Savile Row Track | (unattributed) | Apple iPad per team member | Best UI |

**Open Prizes (not mutually exclusive with tracks):**
- Field Report Track: Keychron Keyboard — best blog post (single winner)
- Radio Traffic Track: Swag boxes — top 10 social media posts

**Bonus:** Job interview opportunities at TrueFoundry for top projects

**OpenAI credits:** $50 in OpenAI credits for in-person SF attendees only. Remote participants bring their own API keys.

---

### Six Judging Criteria (Equal Weight)
1. Potential impact and practical utility
2. Creativity and originality
3. Technical excellence and reliability
4. Effective use of sponsor tools
5. Safety controls and human approval gates
6. Clear demonstration and explanation

**Submission deadline:** August 30, 2026 at 8:00 PM London time

**Submission components required:**
- Public source code repository with functioning README
- Running agent on TrueForge harness (judges must see genuine harness work, not a thin model wrapper)
- ~3-minute demo video
- Short technical write-up explaining the agent and TrueForge integration
- Qodo installed from day one with pull-request review history visible (required to be eligible for the Q Branch / Best Code Quality track)
- Optional: blog post link (for Field Report track consideration)
- No personal API keys or sensitive data in the repo or video

---

## (b) Rules & Eligibility

**Eligibility:**
- Open to anyone worldwide, any experience level; no prior agent experience required
- Free to enter
- Solo or teams of up to 4; each participant on exactly one team

**Technology mandate:**
- Your agent MUST run on TrueForge (the open-source harness). Judges must see the harness doing real work.
- Use of any frameworks, libraries, APIs, templates, and public assets is permitted.
- All coding and design must happen during the August 24–30 window; pre-event planning is allowed.

**Code quality / AI tool disclosure:**
- AI coding assistants (Qodo, Cursor, Copilot, etc.) are permitted but must be disclosed.
- Projects entirely AI-generated with no meaningful human verification or understanding may be disqualified.
- Participants must be able to explain their submitted code.

**Track rules:**
- All submissions are considered for all three judged tracks automatically.
- Each team can win at most one track prize.

**Open-source requirement:** Code must be publicly readable and executable.

**IP:** Participants retain ownership of their work.

**Conduct:** No harassment, discrimination, plagiarism, or judging manipulation. Violations result in disqualification.

---

## (c) Vendor-by-Vendor Deep Dive

---

### Vendor 1: TrueFoundry / TrueForge (REQUIRED — Main Sponsor)

**What it is:**
TrueForge is an MIT-licensed, open-source agent harness — the runtime execution layer that turns an LLM into a working, production-grade agent. It manages the complete loop: model invocations, tool routing, MCP tool connectivity, sandboxed code execution, context compaction, session persistence across restarts, human approval checkpoints, subagent delegation, and streaming UI.

It is NOT a framework like LangGraph or CrewAI (which require you to build your own hosting). TrueForge is an opinionated, complete runtime with batteries included.

**Core Concepts:**
- **Agent Harness:** The orchestration runtime that wraps LLM calls with tools, sandboxes, state, and approvals.
- **MCP (Model Context Protocol):** Standard integration protocol. TrueForge connects to remote MCP servers via header auth or OAuth, including in-chat authorization flows. It handles deferred tool schema loading (critical for MCP servers that expose hundreds of tools — TrueForge only loads what the current task needs to avoid blowing the context window).
- **Skills:** Git-backed SKILL.md instruction packs. You point TrueForge at a git repo and it loads the instructions on demand. This is how you encode runbooks, team conventions, SRE playbooks.
- **Sandbox-as-Tool:** Unlike other harnesses that run the agent inside a sandbox continuously, TrueForge provisions a sandbox (via Daytona) only when code execution is actually needed, improving concurrency and cost.
- **Subagents:** The harness can spawn nested agents to handle subtasks, helping manage context window usage on long-running jobs.
- **Human Approval Gates:** Checkpoints that pause execution and wait for human confirmation before irreversible actions. These are a judging criterion — you MUST use them.
- **Generative UI:** Streams structured UI blocks (not text walls) to the front end. The React SDK (`@truefoundry/trueforge-ui`) lets you embed the chat or build custom interfaces.
- **Session persistence:** Sessions survive restarts (stored in SQLite locally, Postgres in hosted mode).

**Architecture — Three Components:**
1. Core Server (agent execution loop)
2. HTTP API + TypeScript SDK (`@truefoundry/trueforge-sdk`) — REST + Server-Sent Events
3. Chat UI + React SDK (`@truefoundry/trueforge-ui`) — embeddable or standalone

**Deployment modes:**
- **Local mode:** `npx @truefoundry/trueforge` — single process, SQLite storage. Good for hacking. WARNING: No login by default in local mode. Do not expose to the internet without OIDC configured.
- **Hosted mode:** Docker Compose or Kubernetes with Postgres + Redis. Required for multi-replica / team deployments.

**Quickstart:**
```bash
npx @truefoundry/trueforge
# Opens chat UI at localhost. Configure a model provider (OpenAI, Anthropic, Gemini, DeepSeek, any OpenAI-compatible endpoint). Attach MCP servers. Create an agent. Done.
```

**Free tier:** The harness itself is MIT-licensed and free. You only pay for the LLM provider you route through it.

**TrueFoundry AI Gateway (optional add-on):**
- Cloud service that routes traffic across 1,600+ models with RBAC, budget enforcement, guardrails, credential rotation, and unified audit traces.
- Free Developer tier: 50k requests/month, 3 users.
- Paid from $499/month.
- URL: https://www.truefoundry.com/ai-gateway

**MCP / webhook support:** TrueForge is MCP-native. It connects to any remote MCP server via URL + auth header. This is the primary integration mechanism. No webhooks into TrueForge itself, but you can wire your agent to receive webhooks from external systems (PagerDuty, Grafana, etc.) and trigger agent sessions via the TypeScript SDK.

**Cloud-hosted vs local:** TrueForge is local/self-hosted. For the hackathon, local mode (SQLite) is fine. If you want Slack-to-agent webhooks to reach your local TrueForge, you need ngrok or similar to expose the HTTP API.

**SRE-Oncall Integration Ideas:**
- Wire PagerDuty webhook → your backend → create a TrueForge session via SDK → agent auto-triages alert
- Attach MCP servers for PagerDuty, Grafana, Kubernetes, Slack
- Use Skills to load your runbooks (SKILL.md format)
- Human approval gate before any remediation action (required by judges)
- Use subagents for parallel investigation (check metrics AND logs simultaneously)
- Stream findings back to Slack via generative UI or SDK events

**Notable real-world SRE use case (verified):** NetApp deployed TrueForge for incident response and ticket triage automation.

**Docs:** https://trueforge.dev/introduction | https://trueforge.dev/llms.txt (full doc index)
**GitHub:** https://github.com/truefoundry/trueforge
**Blog (launch post):** https://www.truefoundry.com/blog/engineering/trueforge-open-source-agent-harness/

**Cookbook example agents (referenced on resources page):**
- Security Auditor (uses GitHub MCP + Exa search)
- Database Analyst (uses Supabase MCP, writes and executes SQL, generates charts)
- Bring-Your-Own-MCP template

---

### Vendor 2: Qodo (REQUIRED for Q Branch / Best Code Quality Prize)

**What it is:**
Qodo is an AI-powered code review and governance platform. For this hackathon, the Q Branch track requires Qodo to be installed from day one with visible pull-request review history. It is effectively a mandatory vendor if you want the Mac Mini prize and is explicitly named as a judging criterion for "Best Code Quality."

**Core products relevant to hackathon:**
1. **Qodo PR Review (Git Plugin):** Automatic AI review on every pull request. Install the GitHub/GitLab app, and every PR you open gets reviewed by specialized agents that analyze the full codebase context (not just the diff). An application-based open-source programme exists; otherwise it is a 14-day trial then paid.
2. **Qodo Command CLI:** `npm install -g @qodo/command` — runs agents from the terminal or as webhooks. Agents are defined in `.toml` files with trigger/input/action/result sections. Can run in CI mode (machine-readable output) or MCP mode (acts as callable services for orchestrators).
3. **Qodo Agent Skills (`qodo-pr-resolver`):** An Agent Skills-compatible skill that plugs into Claude Code, Cursor, Windsurf, etc. It pulls all flagged PR issues from Qodo's platform, prioritizes by severity, and can auto-fix them. Install: `npx skills add qodo-ai/qodo-skills`.

**Setup for open-source hackathon project:**
1. Create a public GitHub/GitLab repo.
2. Install Qodo app on the repo (14-day trial, no credit card): https://docs.qodo.ai/code-review
3. Every PR you open will be auto-reviewed. This creates the review history judges need to see.
4. Optionally install Qodo Command CLI for additional agent workflows.

**Auth:** OAuth via GitHub/GitLab. For CLI, a Qodo account + API key.

**Free tier:** *Corrected 2026-08-26 against qodo.ai/pricing — the claim below this line was wrong when first written.* There is **no permanent free tier**. Qodo offers a **14-day trial with no credit card** (enough for the whole hackathon window); after that, Pro Team is **$30/user/month**. The open-source programme exists but is **application-based**, not self-serve. Qodo works on private repos as well as public ones.

**MCP/webhook support:** Qodo Command CLI has a "webhook mode" where agents function as HTTP endpoints triggered by external systems via POST requests. It also has "MCP mode" where agents act as callable MCP services. This means you could wire Qodo quality checks into your TrueForge agent's workflow.

**Cloud-hosted vs local:** SaaS + local CLI. The PR review bot is cloud-hosted (no local install needed). The CLI is local.

**SRE-Oncall Integration Ideas:**
- Mandatory: all PRs opened by your SRE agent (e.g., hotfix PRs) get auto-reviewed by Qodo before merging.
- Use the `qodo-pr-resolver` skill in your agent to auto-fix issues flagged during review before requesting human approval.
- Wire Qodo CLI in "CI mode" as a gate in your TrueForge human approval workflow.
- Qodo can review infra-as-code changes (Kubernetes YAML, Terraform) on PRs.

**Docs:** https://docs.qodo.ai | https://docs.qodo.ai/qodo-documentation/qodo-command
**PR agent open source:** https://github.com/qodo-ai/pr-agent
**Skills blog:** https://www.qodo.ai/blog/how-i-use-qodos-agent-skills-to-auto-fix-issues-in-pull-requests/

---

### Vendor 3: PagerDuty (Strongly Recommended — Core SRE Integration)

PagerDuty is not listed as a named hackathon sponsor/track, but it is the canonical alerting/on-call platform and has a first-class MCP server that makes it trivially connectable to TrueForge.

**PagerDuty MCP Server:**
PagerDuty provides an official hosted MCP server exposing 72 tools across 17 domains (50 read-only, 22 writes).

- **Hosted endpoint (no self-hosting needed):**
  - US: `mcp.pagerduty.com/mcp`
  - EU: `mcp.eu.pagerduty.com/mcp`
- **Auth:** `Authorization` header with a PagerDuty User API token (just set `PAGERDUTY_API_TOKEN` env var)
- **Key tools for SRE agent:**
  - `get_incidents` — filter by status/urgency/service/team/time
  - `acknowledge_incident` — mark as being worked
  - `resolve_incident` — close incident
  - `add_incident_note` — document investigation
  - `get_oncalls` — who is on call right now
  - `get_services`, `get_escalation_policies`, `get_schedules`, `get_teams`, `get_users`
  - Webhook subscription tools (create/list webhooks to receive push notifications)

**Webhook support:**
PagerDuty supports outbound webhooks that push incident state changes (triggered/acknowledged/resolved) to your endpoint. Wire these to your TrueForge backend to auto-start agent sessions when an incident fires.

**Free tier / trial:** PagerDuty has a 14-day free trial. For hackathon testing, a free trial account is sufficient.

**Cloud-hosted:** Yes, fully cloud-hosted SaaS. The MCP server is also cloud-hosted. No ngrok needed for your agent to call PagerDuty — but you DO need ngrok if PagerDuty webhooks need to reach your local TrueForge instance.

**Official MCP docs:** https://support.pagerduty.com/main/docs/pagerduty-mcp-server
**Open-source MCP server (self-hosted alternative):** https://github.com/wpfleger96/pagerduty-mcp-server

**SRE-Oncall Integration:**
```
PagerDuty alert fires
  → webhook POST to your ngrok endpoint
    → backend calls TrueForge SDK: create session with SRE agent
      → agent uses PagerDuty MCP: get_incidents, get_oncalls
      → agent queries Grafana/Prometheus MCP for metrics
      → agent requests human approval gate before any remediation
      → agent resolves or escalates via PagerDuty MCP
      → agent writes postmortem
```

---

### Vendor 4: Anthropic / Claude (Strong Recommendation — Model Provider)

TrueForge is model-agnostic, but Anthropic's Claude is one of the four native model options (OpenAI, Anthropic, Gemini, DeepSeek).

**Relevant Claude capabilities for SRE agent:**
- Claude Opus 4.8 / Sonnet 4.6 as the reasoning model — very strong at multi-step tool use and log analysis.
- Claude Agent SDK (Python): full sessions API, MCP toolsets, skills, human approval, streaming.
- Claude cookbook SRE example: https://platform.claude.com/cookbook/managed-agents-sre-incident-responder — shows exactly how to wire PagerDuty webhooks → Claude sessions → Slack approval flow. This architecture maps 1:1 to TrueForge.
- Claude Agent SDK SRE notebook: https://platform.claude.com/cookbook/claude-agent-sdk-03-the-site-reliability-agent

**Model pricing (relevant for cost comparison):**
- Claude Opus 4.8: ~$11.80/run on the enterprise benchmark (Claude Managed Agents). TrueForge brings this to ~$8.50.
- Using open-source models via TrueForge can reduce to ~$3/run.

**Auth:** Anthropic API key from https://console.anthropic.com

**Free tier:** No free tier; pay-per-token. New accounts get some free credits.

---

### Vendor 5: Grafana / Grafana MCP Server (Strongly Recommended — Observability)

**What it exposes (from the official Grafana MCP server):**
- Prometheus: `query_prometheus`, `list_prometheus_metric_names`, `query_prometheus_histogram`
- Loki (logs): `query_loki_logs`, `query_loki_patterns`, `find_error_pattern_logs`
- Alerting: `alerting_manage_rules`, `alerting_manage_routing`, `get_alert_group`, `list_alert_groups`
- Incidents: `create_incident`, `get_incident`, `list_incidents`, `add_activity_to_incident`
- Sift investigations: `create_sift_investigation`, `get_sift_analysis`, `find_slow_requests`
- Dashboards: `get_dashboard_by_uid`, `get_panel_image`, `search_dashboards`
- OnCall: `get_current_oncall_users`, `list_oncall_schedules`, `get_oncall_shift`
- Pyroscope (profiling): available

**Auth:** Grafana API key or service account token.

**Free tier:** Grafana Cloud has a generous free tier (10k series Prometheus, 50GB logs, 14-day retention) — perfect for hackathon. Sign up at grafana.com.

**Cloud-hosted vs local:** Grafana Cloud is fully hosted. The MCP server is also cloud-hosted when connected to Grafana Cloud.

**SRE Integration:**
- Query Prometheus for error rate spikes when an alert fires.
- Query Loki for relevant log lines from the failing service.
- Use `find_error_pattern_logs` and `find_slow_requests` for automated triage.
- Use `create_incident` to open a Grafana incident correlated to a PagerDuty page.
- Use `get_current_oncall_users` for oncall handoff.
- Render a dashboard panel as a PNG image and attach to the Slack postmortem message.

---

### Vendor 6: OpenAI (Model Option + SF Credits)

- Co-sponsor providing $50 credits to in-person SF attendees only. Remote: bring your own key.
- TrueForge supports OpenAI natively (GPT-4o, GPT-4.1, o3, o4-mini).
- Auth: https://platform.openai.com

---

### Vendor 7: Daytona (Sandbox Provider — Integrated with TrueForge)

- TrueForge's default sandbox provider — provisions a sandbox only when code execution is needed.
- Relevance: sandboxed bash for diagnostic scripts, file ops for postmortems, Skills are mounted into the sandbox.
- May need a Daytona account — check trueforge.dev for current integration details (open question).

---

### Vendor 8: Exa / Tavily (Web Search — Built into TrueForge)

- AI-native web search APIs; TrueForge lists both as integrated providers. Tavily powers built-in web search.
- SRE use: search known issues/CVEs/error messages during triage.
- Auth: Exa API key (exa.ai), Tavily API key (tavily.com). Both have free tiers.

---

### Other Integrated Partners (at TrueForge Launch)

| Partner | Category | Notes |
|---|---|---|
| Together AI | Model inference | Cheap open-source model hosting |
| Fireworks AI | Model inference | Fast open-source model serving |
| Alibaba Cloud | Model inference | Hosts Qwen models |
| Bright Data | Web search/retrieval | Web scraping integration |
| Parallel Web | Web search/retrieval | AI search |
| OpenUI | Generative UI | Structured UI component generation |

---

## (d) Recommended Vendor Stack for SRE-Oncall Agent

### Must-Have (required by hackathon rules)
- **TrueForge** — the harness itself. `npx @truefoundry/trueforge`.
- **Qodo** — install the GitHub app on the repo on day one; every agent-opened PR gets visible review history (Q Branch eligibility).

### Core SRE Stack
- **PagerDuty** via hosted MCP (`mcp.pagerduty.com/mcp`) + outbound webhooks → agent sessions.
- **Grafana Cloud + Grafana MCP** — metrics, logs, alerting, oncall; free tier is generous.
- **Claude Opus 4.8 / Sonnet 4.6** as reasoning model (Anthropic SRE cookbook is a direct reference implementation).

### Recommended Optional
- **Slack** — Bolt bot + interactive approval buttons wired to TrueForge approval gates.
- **Kubernetes MCP** — pod health, restarts, diagnostics on a demo cluster.

### Why this stack wins Double-O (Best Use of TrueForge)
- Uses TrueForge's most distinctive features: MCP multi-tool orchestration, skills-based runbooks, sandbox execution, human approval gates, subagents for parallel investigation.
- PagerDuty + Grafana is the canonical SRE stack — immediately legible to judges.
- Human approval gate before remediation is explicitly a judging criterion.

### Why this stack wins Q Branch (Best Code Quality)
- Qodo installed day one; every hotfix PR the agent opens goes through Qodo review.
- `qodo-pr-resolver` skill wired into the agent to auto-fix flagged issues before merge approval.

---

## (e) Open Questions / Unverified Items

1. **TrueForge cookbook examples:** resources page references 9+ example agents; verify at github.com/truefoundry/trueforge which MCP servers each uses.
2. ~~**Qodo free tier PR limits**~~ **Resolved 2026-08-26:** no permanent free tier and no PR cap to work around — a 14-day no-card trial covers Aug 24-30. See PLAN.md §9.
3. **TrueForge ngrok requirement for webhooks:** local TrueForge needs ngrok for inbound webhooks; a free-tier cloud VM avoids this. No cloud hosting requirement in rules.
4. **PagerDuty free tier limits:** 14-day trial covers the window; check for hackathon credits at developer.pagerduty.com.
5. **Daytona account requirement:** unclear if TrueForge bundles a default sandbox or needs a Daytona API key — check trueforge.dev/sandbox.
6. **Savile Row Track sponsor:** unnamed; likely TrueForge UI SDK itself — a polished React chat UI embedding `@truefoundry/trueforge-ui` is the natural play.
7. **Qodo MCP mode with TrueForge:** unverified whether a local Qodo CLI agent can register as an MCP server inside TrueForge (would be a compelling integration: agent reviews its own patches).
8. **SF in-person logistics:** verify capacity/RSVP at https://luma.com/agent-harness.

---

## Sources

- https://www.wemakedevs.org/hackathons/trueforge (+ /rules, /resources)
- https://www.truefoundry.com/trueforge | https://trueforge.dev/introduction | https://trueforge.dev/llms.txt
- https://github.com/truefoundry/trueforge
- https://www.truefoundry.com/blog/engineering/trueforge-open-source-agent-harness/
- https://www.truefoundry.com/pricing | https://www.truefoundry.com/ai-gateway
- https://venturebeat.com/orchestration/truefoundrys-open-source-ai-agent-harness-trueforge-boasts-30-75-cheaper-task-completion-than-claude-managed-agents
- https://wavect.io/blog/trueforge-agent-harness-review/
- https://www.qodo.ai | https://docs.qodo.ai/code-review | https://github.com/qodo-ai/pr-agent
- https://www.qodo.ai/blog/how-i-use-qodos-agent-skills-to-auto-fix-issues-in-pull-requests/
- https://support.pagerduty.com/main/docs/pagerduty-mcp-server
- https://github.com/wpfleger96/pagerduty-mcp-server
- https://www.pagerduty.com/blog/ai/we-built-an-sre-agent-with-memory-and-its-transforming-incident-response/
- https://platform.claude.com/cookbook/managed-agents-sre-incident-responder
- https://platform.claude.com/cookbook/claude-agent-sdk-03-the-site-reliability-agent
- https://techcommunity.microsoft.com/blog/appsonazureblog/get-started-with-pagerduty-mcp-server-and-pagerduty-sre-agent-in-azure-sre-agent/4497124

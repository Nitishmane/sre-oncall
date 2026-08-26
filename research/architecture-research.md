# AI SRE-Oncall Agent: Architecture & Integration Research Report

> Source: research-analyst agent (web research, 2026-08-23).
> Purpose: PagerDuty pipeline, chatbox, MCP inventory, and capability feasibility for the SRE-Oncall project.
> NOTE: This report recommends the Claude Managed Agents SDK as the runtime — but the hackathon RULES require TrueForge as the harness. See PLAN.md for the reconciled decision (TrueForge harness + Claude as model provider; the patterns below still apply).
> NOTE (2026-08-25): **PagerDuty was removed from the live plan** — Grafana Alerting (local kube-prometheus-stack) now webhooks the orchestrator directly and triggers the healing pipeline; the Vercel chatbox moved behind GitHub-OAuth + a server-side bearer bridge. The PagerDuty sections below are retained as historical reference; PLAN.md §3/§11 is the source of truth.

## (a) Recommended End-to-End Architecture

```
                        ┌─────────────────────────────────────────────────┐
                        │              ALERT SOURCES                      │
                        │  Prometheus/Alertmanager  │  Synthetic faults   │
                        └──────────────┬──────────────────────────────────┘
                                       │  Events API v2 (HTTPS POST)
                                       ▼
                        ┌─────────────────────────┐
                        │      PAGERDUTY           │
                        │  (incident management)   │
                        └──────────┬──────────────┘
                                   │  Webhook v3 (incident.triggered)
                                   │  HTTPS POST → ngrok tunnel
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      LOCAL AGENT HOST (laptop/server)                  │
│                                                                         │
│  ┌──────────────────┐     ┌─────────────────────────────────────────┐  │
│  │  Chatbox UI      │     │          AGENT BACKEND (Python/TS)      │  │
│  │  (Next.js/Slack) │────▶│  Agent runtime (harness)                │  │
│  │  SSE streaming   │     │  - Session per incident                 │  │
│  └──────────────────┘     │  - Skill: team runbooks                 │  │
│                           │  - Custom tool: request_approval        │  │
│                           │  - Custom tool: open_pull_request       │  │
│                           └────────────────┬────────────────────────┘  │
│                                            │  stdio                     │
│                           ┌────────────────▼────────────────────────┐  │
│                           │           MCP SERVERS (local stdio)     │  │
│                           │  pagerduty-mcp  │  grafana-mcp          │  │
│                           │  prometheus-mcp │  k8s-mcp              │  │
│                           │  sentry-mcp     │  github/gitlab-mcp    │  │
│                           └─────────────────────────────────────────┘  │
│                                                                         │
│  ngrok tunnel: https://your-name.ngrok-free.app → localhost:8080        │
└─────────────────────────────────────────────────────────────────────────┘
                                            │
                          ┌─────────────────▼───────────────────┐
                          │           EXTERNAL CLOUD             │
                          │  Slack (official MCP at mcp.slack.com│
                          │  GitHub (api.githubcopilot.com/mcp/) │
                          │  Notion (for postmortems)            │
                          └─────────────────────────────────────┘
```

**Key design decision**: The agent runs locally. All local-only MCP servers (Grafana, Prometheus, Kubernetes) connect via stdio — no ngrok needed for them. ngrok is only needed so PagerDuty's cloud webhook can reach your local HTTP webhook listener. Remote MCP servers (Slack at mcp.slack.com, GitHub at api.githubcopilot.com/mcp/, PagerDuty-hosted at mcp.pagerduty.com/mcp) connect directly without tunneling.

---

## (b) PagerDuty Integration Deep-Dive

### 1. Sending Alerts In — Events API v2

**Endpoint**: `POST https://events.pagerduty.com/v2/enqueue`

**Minimal trigger payload**:
```json
{
  "routing_key": "<integration_key_from_service>",
  "event_action": "trigger",
  "dedup_key": "prod-db-01-down",
  "payload": {
    "summary": "Database server prod-db-01 is not responding",
    "severity": "critical",
    "source": "prometheus-alertmanager",
    "custom_details": {
      "alert_name": "InstanceDown",
      "namespace": "production"
    }
  },
  "links": [{"href": "https://grafana.internal/d/abc", "text": "Grafana Dashboard"}]
}
```

`dedup_key` collapses repeat firings of the same alert into one incident. `event_action` can be `trigger`, `acknowledge`, or `resolve`.

**Alertmanager → Events API wiring** (`alertmanager.yml`):
```yaml
receivers:
  - name: pagerduty
    pagerduty_configs:
      - routing_key: <PAGERDUTY_INTEGRATION_KEY>
        severity: '{{ .CommonLabels.severity }}'
        description: '{{ .CommonAnnotations.summary }}'
```

For synthetic demo faults, simply POST to the Events API directly with curl.

### 2. Receiving Alerts Out — Webhook v3

**Event types** most relevant to SRE agent:
- `incident.triggered` — fire the debug pipeline
- `incident.acknowledged` — stop escalation
- `incident.resolved` — generate postmortem
- `incident.annotated` — sync notes to Slack
- `incident.escalated` — page higher tier

**Full `incident.triggered` payload shape**:
```json
{
  "event": {
    "id": "event_abc123",
    "event_type": "incident.triggered",
    "resource_type": "incident",
    "occurred_at": "2025-01-24T03:15:42Z",
    "agent": { "... integration or user that fired it ..." },
    "data": {
      "id": "Q1K3YIQCH6P7AV",
      "number": 1234,
      "status": "triggered",
      "title": "Database server is down - prod-db-01",
      "incident_key": "prod-db-01-down",
      "service": { "id": "SRVCABC", "summary": "Payments Service" },
      "assignees": [{ "id": "USRABCD", "summary": "Jane Doe" }],
      "priority": { "id": "P1ABCDE", "summary": "P1" },
      "urgency": "high"
    }
  }
}
```

**Authentication/verification**: PagerDuty signs each request with HMAC-SHA256. Verify the `X-PagerDuty-Signature` header:
```python
import hmac, hashlib
expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, received_sig)
```

**Setup steps**:
1. In PagerDuty: Integrations → Generic Webhooks (v3) → Add Webhook
2. Set destination URL to `https://your-name.ngrok-free.app/webhook/pagerduty`
3. Scope: account-wide or specific service
4. Subscribe to: `incident.triggered`, `incident.resolved`, `incident.annotated`
5. Copy the generated secret for HMAC verification
6. Use PagerDuty's "Send Test Event" to validate receipt before going live

**Retry behavior**: PagerDuty retries 3 times on failure with exponential backoff (0s, 30s, 120s delays). Your endpoint must return 2xx within the timeout.

### 3. PagerDuty Developer/Free Access

PagerDuty offers a **free 14-day trial** (no credit card required) at pagerduty.com/sign-up. This gives full API access. After the trial, the developer program at developer.pagerduty.com/sign-up/ provides a limited but functional sandbox account. REST API keys are created under Integrations → Developer Tools → API Access Keys. All webhook, schedules, and Events API features are available on the free trial.

### 4. Wiring ngrok for the Webhook Endpoint

```bash
# Install and authenticate (one-time)
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken <your_token>

# Claim your free static domain in the ngrok dashboard, then:
ngrok http --domain=your-name.ngrok-free.app 8080
```

**Free tier** (as of 2026): 1 static domain (e.g. `panda-new-kit.ngrok-free.app`), ~20K requests/month, 1 concurrent tunnel. The static domain persists across restarts — critical so PagerDuty's webhook subscription URL doesn't break every time you restart the tunnel.

**Alternative**: Cloudflare Tunnel (`cloudflared tunnel`) is completely free with no bandwidth caps and no rate limits — better for sustained hackathon demo use, though setup is slightly more involved.

**End-to-end demo alert pipeline**:
```
curl -X POST https://events.pagerduty.com/v2/enqueue \
  -H "Content-Type: application/json" \
  -d '{"routing_key":"<KEY>","event_action":"trigger",
       "payload":{"summary":"Synthetic: pods crashing in prod","severity":"critical","source":"demo"}}'
# → PagerDuty creates incident → fires webhook → ngrok → your handler → agent session starts
```

---

## (c) Chatbox / Chat UI Options

### Option 1: Slack as primary UI (Recommended for hackathon)
Slack is already the SRE's home. The official Slack MCP server at `mcp.slack.com/mcp` has been generally available since February 2026. Use a Slack bot to:
- Receive `/oncall <query>` slash commands or @mentions
- Stream agent responses as threaded replies (chat.postMessage + update pattern)
- Present approval gates as interactive Block Kit buttons

**Pros**: No frontend to build, judges instantly understand it, real workflow tool. **Cons**: No streaming (message updates only), workspace admin must approve the Slack app.
**Effort**: ~2-3 hours to wire up Bolt SDK + Slack MCP.

### Option 2: Next.js chat UI with SSE streaming
A lightweight Next.js app with a chat input; backend streams agent response tokens via Server-Sent Events.
**Pros**: Polished visual demo, easy to show streaming. **Cons**: ~4-6 hours to build something non-embarrassing.

### Option 3: Off-the-shelf: Chainlit or Gradio
Both have 1-file integrations and built-in streaming chat UI. Chainlit is more production-looking.

**Recommendation**: Use **Slack as primary** (fastest, most authentic SRE workflow) and optionally add a minimal chatbox as a backup demo surface. Judges respond well to seeing Slack approval buttons.
(NOTE for our project: TrueForge ships its own Chat UI + React SDK `@truefoundry/trueforge-ui` — that is the natural chatbox for the Savile Row/Best UI track; see PLAN.md.)

---

## (d) Capability-by-Capability Feasibility Guide

### Oncall Handoff Summary
**What it does**: At shift change, query PagerDuty for the outgoing shift's incidents, acknowledgements, ongoing issues, and MTTA/MTTR metrics, then generate a natural-language handoff brief.
**APIs needed**:
- `GET /oncalls?schedule_ids[]=<id>&since=<shift_start>&until=<shift_end>` — who was oncall
- `GET /incidents?since=<shift_start>&until=<shift_end>&statuses[]=resolved,triggered` — incident list
- `GET /incidents/{id}/log_entries` — timeline per incident
**Implementation**: Trigger via PagerDuty schedule webhook or a cron job. Agent reads via PagerDuty MCP tools, drafts a Markdown summary, posts to Slack.
**Effort estimate**: ~3-4 hours (read-only API aggregation).

### Postmortem Generation
**What it does**: After `incident.resolved` fires, stitch together the incident timeline, Slack thread, relevant logs, and the agent's own debug findings into a postmortem draft, then publish.
**Data sources**:
- PagerDuty: `GET /incidents/{id}/log_entries` for timeline
- Slack MCP: fetch the incident Slack thread
- Grafana MCP: pull relevant dashboard panels as context
- Agent session history: the investigation the agent already did
**Publication targets** (pick one for hackathon): Notion (official remote MCP at mcp.notion.com — easiest), GitHub (markdown in `postmortems/` repo), or Slack canvas.
**Effort estimate**: ~4-5 hours. Data aggregation is the hard part; the writing is what the model excels at.

### Alert Deduplication / Correlation
**Implementation**: Use PagerDuty's `incident_key` (dedup_key in Events API) — same key = same incident. For cross-service correlation, use PagerDuty's Alert Grouping if available on your tier, or a simple time-window grouper in the webhook handler.
**Effort estimate**: ~2 hours (partly built into PagerDuty already).

### Runbook Execution
**Implementation**: Mount runbooks as a Skill in the agent definition. The agent runs `kubectl rollout restart`, scales deployments, etc. via k8s MCP — with an approval gate before any destructive action.
**Effort estimate**: ~3-4 hours to write 3-5 runbooks and wire the approval gate.

### Status Page Updates
**Options**: PagerDuty Status Pages API (in trial), or Atlassian Statuspage. PagerDuty MCP has `create_status_page_post` / `create_status_page_post_update` built in.
**Effort estimate**: ~1-2 hours. Very demo-friendly.

### Incident Severity Classification
**Implementation**: PagerDuty MCP `manage_incidents` write tool (requires `--enable-write-tools`). Agent evaluates payload + Prometheus metrics and sets priority (P1–P4).
**Effort estimate**: ~1-2 hours.

### Auto-Remediation with Approval Gates (crown jewel for the demo)
1. Agent investigates → proposes fix → calls `open_pull_request` (custom tool)
2. Agent calls `request_approval` → session pauses → Slack Block Kit buttons appear
3. Oncall engineer clicks Approve → session resumes → agent merges

---

## (e) MCP Server Inventory

| Name | Official / Community | Transport | Auth | Cloud / Local | Link |
|------|---------------------|-----------|------|---------------|------|
| PagerDuty MCP | Official (PagerDuty) | stdio (default), streamable-HTTP, SSE | `PAGERDUTY_USER_API_KEY` env var | Cloud-hosted at `mcp.pagerduty.com/mcp` OR local | https://github.com/PagerDuty/pagerduty-mcp-server |
| Grafana MCP | Official (Grafana Labs) | stdio + streamable-HTTP | Grafana API token | Cloud (Grafana Cloud) or local | https://github.com/grafana/mcp-grafana |
| Prometheus MCP | Official (prometheus org) | stdio | None (URL env var) | Local only — ngrok if agent is remote | https://github.com/prometheus/prometheus-mcp |
| Kubernetes MCP | Community (Flux159, most used) | stdio, SSE, streamable-HTTP | kubeconfig / kubectl context | Local only | https://github.com/Flux159/mcp-server-kubernetes |
| Sentry MCP | Official (getsentry) | stdio + remote | Sentry auth token | Cloud-hosted or local | https://github.com/getsentry/sentry-mcp |
| Slack MCP | Official (Slack) | streamable-HTTP | OAuth | Cloud only — `mcp.slack.com/mcp` | https://docs.slack.dev/ai/slack-mcp-server/ |
| GitHub MCP | Official (GitHub) | streamable-HTTP | GitHub token or OAuth | Cloud only — `api.githubcopilot.com/mcp/` | https://github.com/github/github-mcp-server |
| GitLab MCP | Official (GitLab) | stdio, HTTP, OAuth | GitLab PAT | Cloud (gitlab.com) or self-hosted | https://docs.gitlab.com/user/model_context_protocol/mcp_server/ |
| ArgoCD MCP | Akuity (ArgoCD maintainers) | stdio, SSE | `ARGOCD_BASE_URL` + `ARGOCD_API_TOKEN` | Local/in-cluster ArgoCD (port-forward if in kind; ngrok only if agent is remote) | https://github.com/akuity/argocd-mcp |
| Terraform MCP | Official (HashiCorp) | stdio (Docker) | None for registry; TFE token for HCP Terraform | Local (registry lookups hit registry.terraform.io) | https://github.com/hashicorp/terraform-mcp-server |
| Terraform MCP (AWS Labs) | Official (AWS Labs) | stdio | AWS creds for execution | Local — runs `terraform plan/validate` + Checkov scans | https://github.com/awslabs/mcp (terraform-mcp-server) |
| n8n-mcp (workflow builder) | Community (czlonkowski, 22.8k★) | streamable-HTTP (`:3000/mcp`) | `MCP_AUTH_TOKEN` bearer + `N8N_API_KEY` to n8n | Local Docker (hosted tier capped at 100 calls/day) | https://github.com/czlonkowski/n8n-mcp |
| n8n MCP Server Trigger | Official (n8n native node) | streamable-HTTP / SSE (deprecated) on `:5678/mcp/...` | Bearer or header auth | Local Docker n8n (free) or n8n Cloud (€20/mo+); ngrok only if a remote agent must call in | https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger |
| Notion MCP | Official | streamable-HTTP | OAuth | Cloud only | via claude.ai integrations / mcp.notion.com |

**Note on "local MCP + agent runs locally"**: When the agent process itself runs on your machine, all stdio MCP servers connect as child processes — no ngrok needed for them. ngrok is only needed for PagerDuty's cloud webhook to reach your local HTTP server.

**Note on "local MCP + cloud agent"**: If the agent runs on a cloud host, expose local Grafana/Prometheus/k8s via ngrok tunnels with SSE/streamable-HTTP transport, then pass those URLs as `{"type": "url", "url": "https://...ngrok-free.app/mcp"}` in the agent's MCP config. For a hackathon, keep the agent local to avoid this complexity.

---

## (f) Agent Runtime Comparison (pre-reconciliation)

This section compared Claude Managed Agents SDK vs `claude -p` headless vs raw API loop and recommended the Managed Agents SDK for its session persistence, approval gates (`requires_action` / `user.custom_tool_result`), per-agent MCP config, Skills, and the SRE cookbook example (platform.claude.com/cookbook/managed-agents-sre-incident-responder).

**HOWEVER: the hackathon mandates TrueForge as the harness.** TrueForge provides the same primitives (sessions, MCP, skills, approval gates, subagents, SDK+SSE). The Managed Agents cookbook remains a valuable architectural reference — its webhook→session→approval flow maps 1:1 onto TrueForge's SDK. Notes that still apply regardless of runtime:
- Session-per-incident isolation; cap concurrent sessions and fire demo alerts one at a time.
- Approval gates as first-class pauses, resumed by button-press events.
- MCP servers declared per-agent at creation time.
- Runbooks mounted as skills.

---

## (g) Demo Script Suggestion

**Setup (before judges, ~15 min)**: start ngrok, start agent backend, open Slack oncall channel, open PagerDuty in browser.

**Demo flow (~8 minutes)**:
1. **"Here's our production environment"** — Grafana dashboard, all green (30s)
2. **"Trigger a real incident"** — curl to Events API v2: synthetic "pods crashing" alert (30s)
3. **"PagerDuty receives it"** — incident appears, webhook fires (30s)
4. **"Our SRE agent wakes up automatically"** — Slack: "I've received a P1 alert for Payments Service. Investigating now..." (30s)
5. **"The agent investigates"** — narrate: Grafana metrics spike, live k8s events + pod logs via k8s MCP, ArgoCD sync history ("this started 4 minutes after sync #42 deployed"); show streaming investigation (2 min)
6. **"Root cause + proposed fix"** — "OOM kill on checkout-svc. Proposed fix: memory 512Mi → 1Gi. Opening draft PR..." (1 min)
7. **"Human approval gate"** — Slack Block Kit Approve/Reject buttons; press Approve (30s)
8. **"Fix merged, incident resolves"** — agent merges PR, resolves PagerDuty incident (30s)
9. **"Postmortem auto-generated"** — show the published postmortem: timeline, root cause, fix, recommendations (1 min)
10. **"Oncall handoff"** — trigger handoff summary command, show shift summary in Slack (30s)

**Key judge talking points**: "Zero-touch P1 response in under 5 minutes. Human stays in control via approval gates. Every step is auditable."

---

## (h) Risks and Gotchas

- **PagerDuty free trial expires in 14 days.** Sign up the day before the hackathon, not earlier.
- **ngrok free tier 2026 restrictions**: 20K requests/month, 1 concurrent tunnel. Backup: Cloudflare Tunnel (`cloudflared tunnel --url localhost:8080`) — free, no caps.
- **Webhook HTTPS requirement**: PagerDuty v3 webhooks require public HTTPS; plain localhost is rejected.
- **MCP server startup order matters**: start stdio MCP servers before the agent backend.
- **Kubernetes MCP auth**: uses local `~/.kube/config`; verify kubectl context before starting the agent.
- **Concurrent session limits**: fire synthetic alerts one at a time during the demo.
- **Slack MCP workspace admin approval**: do this setup the day before.
- **Write tools opt-in**: PagerDuty MCP needs `--enable-write-tools` or the agent is read-only.
- **Postmortem data freshness**: wait 30–60s after `incident.resolved` before querying log_entries.

---

## Sources

- https://developer.pagerduty.com/docs/db0fa8c8984fc-overview (Webhook v3)
- https://developer.pagerduty.com/api-reference/YXBpOjI3NDgyNjU-pager-duty-v2-events-api
- https://github.com/PagerDuty/pagerduty-mcp-server | https://pagerduty.github.io/pagerduty-mcp-server/docs
- https://platform.claude.com/cookbook/managed-agents-sre-incident-responder
- https://platform.claude.com/docs/en/managed-agents/multi-agent
- https://github.com/grafana/mcp-grafana | https://grafana.com/docs/grafana/latest/developer-resources/mcp/
- https://github.com/getsentry/sentry-mcp | https://github.com/prometheus/prometheus-mcp
- https://github.com/Flux159/mcp-server-kubernetes
- https://docs.slack.dev/ai/slack-mcp-server/ | https://github.com/github/github-mcp-server
- https://docs.gitlab.com/user/model_context_protocol/mcp_server/
- https://ngrok.com/blog/free-static-domains-ngrok-users | https://ngrok.com/docs/pricing-limits/free-plan-limits
- https://www.pagerduty.com/sign-up/ | https://developer.pagerduty.com/sign-up/
- https://inventivehq.com/blog/pagerduty-webhooks-guide

# Reference Agent — Forensic Analysis for SRE-Oncall Replication

> Source: code-searcher agent analysis of the internal reference-agent repository (2026-08-23, original machine).
> Purpose: reference architecture for the TrueForge hackathon "SRE-Oncall" agent.
> NOTE: This document has been anonymized for public use — company names, internal hostnames, repo/channel names, and vendor stack details have been replaced with generic placeholders. Do not re-introduce company identifiers; this directory feeds a public hackathon repo.

## (a) Project Overview & Tech Stack

**The reference agent** is a production Slack AI assistant for a mid-size engineering org. It is a TypeScript (Node.js ESM) application, `version: 2.0.0`, using:

- **AI Framework**: `@anthropic-ai/claude-agent-sdk` `^0.3` — spawns the `@anthropic-ai/claude-code` CLI as a subprocess and speaks `stream-json` over stdio. This is NOT the raw Messages API — it is the Claude Agent SDK driving the Claude Code CLI.
- **Primary model**: `claude-opus-5` (configurable via `ANTHROPIC_PRIMARY_MODEL`)
- **Secondary/compose model**: `claude-sonnet-5` (configurable via `ANTHROPIC_COMPOSE_MODEL`)
- **Slack**: `@slack/bolt ^4.1.0`, `@slack/web-api ^7.8.0` — Socket Mode (no inbound HTTP; no ingress required)
- **Persistence**: `better-sqlite3 ^12.8.0` — local SQLite for sessions, receipts, workspaces, groups, preferences
- **Queuing**: `ioredis ^5.4.2` — per-thread Redshift warehouse query queue
- **AWS**: `@aws-sdk/client-athena`, `@aws-sdk/client-s3`, `@aws-sdk/client-secrets-manager`
- **Deployment**: docker-compose on a single EC2 host; secrets from AWS Secrets Manager via instance profile
- **Sidecars**: Presidio (PII scrubbing, Python/FastAPI), Whisper (voice transcription), Kroki (diagram rendering), renderer (Playwright HTML→PNG/PDF), db-proxy (Postgres anonymization layer)

---

## (b) Directory/File Map with Roles

```
reference-agent/
├── src/
│   ├── index.ts                         # Engine entry point — message router, module dispatch loop
│   ├── config.ts                        # All env-var configuration (requireEnv, parseIntEnv)
│   ├── constants.ts                     # Shared regex, string constants, Slack helpers
│   ├── contracts.ts                     # Core TypeScript interfaces (IncomingMessage, SlackClient, etc.)
│   ├── relay/
│   │   ├── relay.ts                     # Slack Socket Mode holder; POSTs events to engine HTTP endpoints
│   │   ├── routing.ts                   # Parses config/routing.yaml, hot-reloads, polls /tenants
│   │   └── socket-lifecycle.ts          # Reconnect catch-up, connection-count warnings, clean shutdown
│   ├── engine/
│   │   ├── startup.ts                   # Boot sequence — 8-phase init (proxies, profiles, catch-up, ready)
│   │   ├── server.ts                    # HTTP server on port 3940 — /health, /catchup, /tenants
│   │   ├── preflight.ts                 # Checks claude-code CLI and ANTHROPIC_API_KEY at boot
│   │   └── health.ts                    # Health state machine (starting → ready → unhealthy)
│   ├── conversation/
│   │   ├── concurrency.ts               # Global slot semaphore + per-thread promise-chain serialization
│   │   ├── channel-concurrency.ts       # Per-channel cap layered before global pool
│   │   ├── thread-runner.ts             # respondInThread — acquires slot/workspace, runs state machine
│   │   ├── thread-coordinator.ts        # Cross-store per-thread state: sessions + workspaces + profiles
│   │   ├── sessions.ts                  # SQLite: thread_sessions, parked_sessions, thread_prompts
│   │   ├── workspace.ts                 # Chroot workspace lifecycle (create, bind-mount, teardown)
│   │   ├── chroot-spawn.ts              # Spawns claude-code CLI inside chroot via unshare(PID ns)
│   │   ├── cancellation.ts              # AbortController registry per thread; /stop handler
│   │   ├── incidents.ts                 # SQLite incident store for alert-storm coalescing
│   │   ├── dedup.ts                     # In-memory seen-set for Slack event deduplication
│   │   └── state-machine/
│   │       ├── orchestrator.ts          # runStateMachine — SUMMARIZE→LOAD→INVESTIGATE→REFLECT→TLDR
│   │       ├── step-caller.ts           # runStep — API call with model selection, retries, timeouts
│   │       ├── dispatch.ts              # dispatchStateMachineResult — posts answer + footer to Slack
│   │       └── steps/
│   │           ├── summarize.ts         # Thread context summarization (Sonnet, no tools)
│   │           ├── load.ts              # Capability selector — emits "LOAD: name1, name2" line
│   │           ├── investigate.ts       # Primary step — runs claude-agent-sdk query() in chroot
│   │           ├── reflect.ts           # Quality gate — ship-as-is | ship-with-tweaks | kick-back
│   │           ├── tldr.ts              # Optional TLDR distillation for terse mode
│   │           └── reflect-tldr.ts      # Formatting cleanup pass on the TLDR
│   ├── modules/
│   │   ├── registry.ts                  # Module list; shouldHandle priority order
│   │   ├── claim-bind.ts                # claimAndBind — walks modules, writes profile binding
│   │   ├── general/module.ts            # Catch-all (priority -1), claims any @mention
│   │   ├── sentry/                      # Auto-triage for Sentry alert channels
│   │   ├── pagerduty/
│   │   │   ├── module.ts                # shouldHandle (PD bot UID + allowed channels), preFilter, frameQuestion
│   │   │   ├── parser.ts                # parsePagerDutyMessage — extracts incidentId/URL/status from Slack blocks
│   │   │   ├── config.ts                # pagerduty config object (env vars → typed config)
│   │   │   ├── defer.ts                 # Flap-delay: holds alert N seconds, rechecks if resolved
│   │   │   ├── filter.ts                # shouldSkip (dedup), matchesDelayPattern
│   │   │   └── catchup.ts               # Startup scan for missed PD alerts
│   │   ├── incident/                    # Alert-storm coalescing module
│   │   └── mr-review/                   # GitLab MR poll loop, auto-review dispatch
│   ├── proxies/
│   │   ├── anthropic.ts                 # Unix-socket proxy holding real ANTHROPIC_API_KEY
│   │   ├── api.ts                       # Shared API proxy: Sentry/JIRA/Notion/Grafana/PD/Google/etc.
│   │   ├── slack.ts                     # Per-session Slack Web API proxy (read-mostly, PII-scrubbed writes)
│   │   ├── gitlab/proxy.ts              # GitLab API proxy enforcing repos.yaml allowlist
│   │   ├── mcp-proxy.ts                 # TCP-localhost reverse proxy for MCP-over-HTTP (vendor MCPs)
│   │   ├── <vendor-a>-mcp.ts            # third-party BI/analytics MCP proxy
│   │   ├── <vendor-b>-mcp.ts            # third-party attribution MCP proxy
│   │   ├── redis.ts                     # Redis read-only proxy
│   │   ├── s3.ts                        # S3 read proxy
│   │   ├── warehouse.ts                 # Redshift warehouse proxy + per-thread queue
│   │   └── athena.ts                    # Athena raw-events proxy
│   ├── analyzer/
│   │   ├── prompts.ts                   # loadPrompts, buildPromptBundle, resolveLoadIntent
│   │   └── tool-policy.ts               # Tool allowlist: Read/Grep/Glob/Bash/Skill/Agent (no Write/Edit by default)
│   ├── profiles/
│   │   ├── loader.ts                    # loadProfiles (YAML → Profile objects), group membership cache
│   │   ├── resolver.ts                  # applyChannelToneOverlay, profile composition
│   │   ├── authorization.ts             # isBlockedByActiveProfile — elevated session gating
│   │   └── commands/                    # /mode, /tone, /set, /why, /help, /stop, etc.
│   ├── slack/
│   │   ├── dm-privacy.ts                # DM privacy banner (posted once per thread)
│   │   ├── external-dm-gate.ts          # Rejects DMs from external-org Slack users
│   │   ├── pii-scrubber.ts              # Presidio sidecar client
│   │   ├── formatting.ts                # postChunked — splits long messages for Slack's limit
│   │   └── users.ts                     # email↔UID mapping, @mention resolution
│   ├── storage/
│   │   ├── receipt-log.ts               # /why audit receipts (tool trail per turn)
│   │   ├── tool-log.ts                  # Per tool_use event log (JOINed into /why)
│   │   ├── invocation-log.ts            # Posts one-liner to #reference-agent-log after every invocation
│   │   └── groups-store.ts              # group_memberships SQLite table; admin group is privilege root
│   ├── catchup/
│   │   ├── catchup.ts                   # Post-reconnect sweep for missed Slack mentions
│   │   └── mention.ts                   # conversations.replies-based mention enqueue
│   └── rendering/
│       ├── tag-dispatcher.ts            # Extracts <mermaid>/<table>/<snippet>/<pdf> from model output
│       └── receipt-handler.ts           # Strips <receipt> blocks (defense-in-depth)
├── profiles/
│   ├── default.yaml                     # Default profile: read + jira + notion + slack-search, snapshot DB
│   ├── pagerduty.yaml                   # PD triage profile: production DB + grafana + PD + all data sources
│   ├── production.yaml                  # /mode production profile
│   ├── gitlab-rw.yaml                   # /mode gitlab-rw — write-capable code development
│   ├── admin.yaml                       # /mode admin — operator inspection
│   └── ...                              # jira-rw, notion-rw, sentry, support, press, api, simple, mr-review
├── prompts/
│   ├── base.md                          # System prompt: role definition, RESEARCH/INVESTIGATE/COMPOSE phases
│   ├── pagerduty.md                     # PD triage playbook (fetches incident/alerts/service from PD API, then Grafana)
│   ├── grafana.md                       # Grafana capability (datasource map, read-only rule, PromQL/LogQL guide)
│   ├── database.md                      # Postgres query capability
│   ├── notion.md                        # Notion KB search
│   ├── jira.md                          # JIRA lookup
│   ├── slack-search.md                  # Slack channel history search
│   ├── argocd.md                        # ArgoCD deployment health
│   └── ...                              # sentry, mr-review, database-admin, warehouse, athena, etc.
├── config/
│   ├── routing.yaml                     # Channel→engine routing, log/why/delete channels (hot-reloadable)
│   ├── repos.yaml                       # GitLab repos Claude can clone + channel_hints + channel_modules
│   ├── channel-limits.yaml              # Per-channel concurrency caps
│   ├── channel-tones.yaml               # Default tone per channel (engineer/support/general/simple)
│   ├── groups.json                      # Group catalog (admin, production, gitlab-rw, etc.)
│   └── host-queue.yaml                  # Tenant engine host-queue config
├── Dockerfile                           # Multi-stage: builds TS, bakes claude-code CLI at exact SDK-matched version
├── docker-compose.yml                   # Services: relay, reference-agent (main engine), sidecars
└── docs/
    ├── architecture.md                  # Relay/engine split, state machine, sessions — the essential deep-dive
    ├── request-lifetime.md              # Full lifecycle: Slack event → agent → response (8 stages)
    ├── secrets.md                       # AWS Secrets Manager layered model
    └── ...                              # profiles, prompts, security, observability, alert-coalescing
```

---

## (c) Threading/Concurrency Model — Deep Dive

The system uses a **single-process async Node.js model** with three layered concurrency controls. There are NO OS processes or worker threads per conversation — everything is Promise-based async within one Node.js event loop.

### Layer 1: Per-thread serialization (`src/conversation/concurrency.ts:54-76`)

A `Map<string, Promise<void>>` (keyed by `threadTs`) chains work into a promise queue. Each `enqueueForThread(threadTs, fn)` call appends `fn` to the thread's promise chain — so multiple rapid replies in the same Slack thread are processed strictly in order, never concurrently.

```typescript
// concurrency.ts:54-76
export function enqueueForThread<T>(threadTs: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadDone.get(threadTs) ?? Promise.resolve();
  let done!: Promise<void>;
  const result: Promise<T> = new Promise((resolve, reject) => {
    done = previous.then(async () => { try { resolve(await fn()); } catch (err) { reject(err); } });
  });
  threadDone.set(threadTs, done);
  done.then(() => { if (threadDone.get(threadTs) === done) { threadDone.delete(threadTs); } });
  return result;
}
```

### Layer 2: Per-channel concurrency cap (`src/conversation/channel-concurrency.ts`)

Channels listed in `config/channel-limits.yaml` get a cap applied before competing for the global pool. This prevents alert-heavy channels (e.g. `#sentry-alerts`) from draining all global slots during an alert storm. Channels not listed bypass this layer.

### Layer 3: Global slot semaphore (`src/conversation/concurrency.ts:1-45`)

```typescript
const MAX_CONCURRENT = config.maxConcurrentConversations;  // env: MAX_CONCURRENT_CONVERSATIONS (default: 4)
let activeConversations = 0;
const globalQueue: Array<{ resolve: () => void }> = [];
```

A simple counter + FIFO queue. When all slots are taken, `acquireSlot()` returns a Promise that resolves when a slot is released. A "waiting for slot" message is posted to the thread while it waits.

### Cancellation

Each thread gets an `AbortController` registered in `src/conversation/cancellation.ts`. The `cancelThread(threadTs)` function aborts the controller, which propagates as an `AbortSignal` into the SDK's `query()` call. A `/stop` mention bypasses all queueing and calls `cancelThread` directly.

### How a new session is invoked per thread

When `respondInThread` (`src/conversation/thread-runner.ts`) runs for a thread:

1. Acquires a global slot (`acquireSlot()`)
2. Acquires or creates a chroot workspace keyed by `threadTs`
3. Calls `getSession(threadTs)` from SQLite to retrieve a prior `session_id`
4. Calls `runStateMachine()` which eventually calls `investigateStep()`
5. `investigateStep()` calls `@anthropic-ai/claude-agent-sdk`'s `query()` with `--resume <session-id>` if one exists
6. The SDK spawns `claude-code` as a **child process** inside the chroot sandbox
7. Communication is over `stream-json` on the stdio pipe
8. On completion, `setSession(threadTs, newSessionId)` persists the SDK session ID to SQLite
9. On the NEXT message in the thread, `getSession` retrieves it and passes it as `--resume`

### Where session state is stored

Three places, all in the `reference-agent-data` Docker named volume:

1. **SQLite `thread_sessions` table** (`src/conversation/sessions.ts`) — maps `thread_ts → session_id`; 48-hour TTL
2. **SDK conversation `.jsonl` file** — written by the `claude-code` CLI to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` inside the chroot, which is **bind-mounted** from `/var/lib/reference-agent/sdk-projects/<thread_ts>/` so it survives workspace teardowns
3. **SQLite `parked_sessions` table** — parked sessions when `/mode` switches profiles

### How conversation resumes on a follow-up reply

When a user replies in an existing thread:

1. The relay sees a Slack `message_changed` or `message` event with `thread_ts` set
2. The relay POSTs to the engine's HTTP endpoint
3. `onMessage` in `src/index.ts` extracts `normalized.threadTs`
4. `handleDirectMention` or `handleModuleRouting` calls `enqueueForThread(threadTs, ...)` — appended to the thread's promise chain so it runs after any in-flight work
5. `thread-runner.ts:respondInThread` runs `getSession(threadTs)` → gets the prior session ID
6. `fetchAndFormatThreadContext` calls `conversations.replies` to build the thread history text
7. `fetchMissedMessages` collects Slack messages from other users since the last bot reply
8. `investigateStep` calls SDK `query()` with `--resume <session-id>` → model has full prior tool-use history already in the SDK session

---

## (d) Codebase Knowledge Mechanism

The reference agent knows about codebases through **on-demand git clone into isolated chroot workspaces**, not embeddings or RAG.

**Authoritative config**: `config/repos.yaml` — lists every GitLab repo Claude can clone, with:
- `path`: GitLab project path (e.g. `org/main-service`)
- `gitlab_project_id`: numeric ID (for the proxy allowlist)
- `branch`: default branch to clone
- `description`: injected into the system prompt as the "Repo Guide" so the model knows which repo to look in for each domain

**How it works at runtime**:
1. The system prompt (`prompts/base.md`) instructs the model to use `git clone` via `Bash` to pull repos into the chroot workspace
2. The **GitLab proxy** (`src/proxies/gitlab/proxy.ts`) acts as a transparent proxy: the chroot calls `git clone https://reference-agent-proxy/...` and the proxy authenticates with the real `GITLAB_TOKEN`
3. The proxy enforces the `repos.yaml` allowlist — the model can only clone repos explicitly listed there
4. Once cloned, repos persist in the chroot workspace across turns in the same thread (workspaces are reused for 7 days idle TTL)
5. The model uses `Read`, `Grep`, `Glob`, `Bash` tools to navigate the code

**Channel hints** (`config/repos.yaml:channel_hints`): Maps Slack channel IDs to repo keys and context hints that are injected into the system prompt, so in a team channel (e.g. `#team-mobile`) the model knows to look first at that team's repos.

**Channel modules** (`config/repos.yaml:channel_modules`): Forces specific capability modules always loaded for certain channels (e.g. `argocd` always in `#k8s-alerts`, `mr-review` always in team channels).

**CLAUDE.md files**: The cloned repos can have their own `CLAUDE.md` files that the model reads when investigating code in those repos. The model is instructed (in `prompts/base.md`) to read these for repo-specific conventions.

**Prompt modules** (`prompts/*.md`): Capability playbooks with YAML frontmatter. Each module describes what tool calls to make for that capability (e.g. `prompts/grafana.md` describes how to call `/api/ds/query`, which datasource UIDs to use, etc.). The LOAD step picks which modules to activate per turn.

---

## (e) Slack Setup — Everything to Replicate

### Connection method

**Socket Mode** (`@slack/socket-mode` inside `@slack/bolt`). No inbound HTTP port. The relay holds the WebSocket connection to Slack. This means:
- No public IP or ingress needed
- Slack delivers events to the WebSocket
- The relay immediately forwards each event as an HTTP POST to the engine

### Architecture: Relay → Engine split

The relay (`src/relay/relay.ts`) is a **separate process/container** from the engine. It holds the Socket Mode WebSocket and forwards events to engine HTTP endpoints. This lets engines restart without dropping the Slack connection — users see "restarting" messages instead of silence.

```
Slack ─── WebSocket ──► relay (src/relay/relay.ts)
                           │  HTTP POST to http://reference-agent:3940
                           ▼
                        engine (src/index.ts + src/engine/server.ts)
                           │  202 Accepted immediately (async processing)
                           ▼
                        respondInThread → state machine → claude-code subprocess
```

### Slack App Scopes Required

**Bot Token Scopes** (from the Web API calls observed):
- `app_mentions:read` — receive @mention events
- `channels:history` — `conversations.history`, `conversations.replies`
- `channels:read` — `conversations.info`
- `chat:write` — `chat.postMessage`, `chat.update`, `chat.delete`
- `files:read` — download user-uploaded files
- `files:write` — `files.uploadV2` (for snippets, PDFs, images)
- `groups:history` — private channel history (for explicitly-routed private channels)
- `groups:read` — private channel info
- `im:history` — DM history
- `im:read` — DM info
- `im:write` — post to DMs
- `mpim:history`, `mpim:read`, `mpim:write` — group DM support
- `users:read` — `users.info`, `users.list` (for email→UID mapping, team_id checks)
- `users:read.email` — user email lookup

**Socket Mode**: Requires an app-level token (`SLACK_APP_TOKEN`, `xapp-...`) in addition to the bot token (`SLACK_BOT_TOKEN`, `xoxb-...`).

**Event Subscriptions** (Socket Mode, so no Event Subscriptions URL needed):
- `message.channels` — messages in public channels
- `message.groups` — messages in private channels
- `message.im` — direct messages
- `message.mpim` — group DMs

### Required Environment Variables (Slack-related)

```bash
SLACK_BOT_TOKEN=xoxb-...         # Bot OAuth token
SLACK_APP_TOKEN=xapp-...         # App-level token for Socket Mode
SLACK_SIGNING_SECRET=...         # For request signature verification
REFERENCE_AGENT_BOT_USER_ID=U0XXXXXXXXX      # Bot's own Slack user ID (or discovered via auth.test at boot)
```

### How mentions/DMs trigger the agent

1. Slack delivers event to relay WebSocket
2. Relay parses `routing.yaml` to find which engine handles the channel
3. Relay POSTs `{ raw: SlackRawEvent, channelType, explicitlyRouted, crossPost, allowedUsers, logChannel, ... }` to `http://<engine>:3940/event`
4. Engine acknowledges `202` immediately
5. Engine's `onMessage` function processes the event asynchronously:
   - Extracts normalized message via `extractMessage(raw)`
   - For `channelType === "im"`: synthesizes an @mention so every DM dispatches even without explicit mention
   - For mentions: calls `handleDirectMention` → `dispatchUserMessage` → `enqueueForThread` → `respondInThread`
   - For non-mentions (bot messages like PagerDuty): calls `handleModuleRouting` → `claimAndBind` → `enqueueForThread` → `respondInThread`

### How responses are posted back

`src/slack/formatting.ts:postChunked()` splits long responses to stay within Slack's message size limit. The engine calls `client.chat.postMessage` (for new messages) or `client.chat.update` (for editing status messages in-place). All Slack API calls from inside the chroot go through the per-session Slack proxy socket (`src/proxies/slack.ts`) — the model uses `curl --unix-socket` to hit it.

### Streaming updates

There is no streaming of the final response token-by-token. Instead, a **periodic status message** is posted and edited in-place:
- `threadStatus()` in `src/conversation/thread-runner.ts:76-128` posts "Still working... 45s, 12 turns, 8.3k tokens" as a single evolving message
- The status message is created on first call and `chat.update`-d on subsequent calls
- When live-activity mode is enabled, each tool use event triggers a status update

---

## (f) Alert Triage Flow — PagerDuty

### How alerts reach the agent

PagerDuty alerts reach the reference agent via **Slack messages** posted by the PagerDuty Slack integration bot. There is NO PagerDuty webhook hitting the reference agent directly.

**Setup**: The PagerDuty Slack app posts an alert message to configured Slack channels (e.g. `#pagerduty-oncall`). The alert message contains a structured Block Kit payload with an `/incidents/` URL and a leading status emoji (🔴 = triggered, 🟢 = resolved).

### Trust boundary

`src/modules/pagerduty/module.ts:shouldHandle()`:
```typescript
return msg.user === pagerduty.pagerdutyUserId && pagerduty.channels.includes(msg.channel);
```
The message is ONLY dispatched as an auto-triage if it comes from the PagerDuty bot's Slack user ID AND the channel is in the allowlist. This is the security boundary — arbitrary users cannot trigger auto-triage.

### The triage flow step by step

1. **PagerDuty Slack bot posts** a message to a configured channel with a Block Kit payload containing the incident URL
2. **`shouldHandle()`** checks: sender is PagerDuty bot UID + channel is in `PAGERDUTY_CHANNELS`
3. **`preFilter()`** (`src/modules/pagerduty/module.ts:31-54`):
   - Calls `parsePagerDutyMessage()` to extract `incidentId`, `incidentUrl`, `status` from Slack blocks
   - Drops if status is not `"triggered"` (acked, resolved → silent skip)
   - Calls `shouldSkip()` for dedup (same incident seen recently → skip)
   - Calls `matchesDelayPattern()` — for flap-prone alert types, defers for `PAGERDUTY_DELAY_SECONDS` (default 300s); if the incident self-resolves in that window, triage is skipped silently
4. **`frameQuestion()`** (`src/modules/pagerduty/module.ts:56-63`):
   - Returns `"Triage this PagerDuty incident: https://<org>.pagerduty.com/incidents/PABC123"`
   - NOTE: Only the canonical URL is passed — never the title or alert-author text (prompt injection defense)
5. **`claimAndBind()`** resolves the `pagerduty` profile (`profiles/pagerduty.yaml`):
   - Activates production database, Redis, S3, Warehouse, Athena, Slack search, Notion credentials
   - Sets tone `engineer`, disables terse mode, posts `production-warning` banner
6. **State machine runs** with the `pagerduty` + `grafana` capability modules pre-loaded
7. **INVESTIGATE** step (Claude Opus with production access):
   - Uses `curl --unix-socket` to the API proxy to call the PagerDuty REST API:
     - `GET /incidents/{id}` — incident details, service, escalation policy
     - `GET /incidents/{id}/alerts` — individual alerts with AlertManager payload (runbook links)
     - `GET /oncalls` — who is currently on-call
   - Calls the Grafana API proxy to find and query relevant dashboards (datasource UIDs, PromQL queries)
   - Queries Postgres (production read-replica) for service state if relevant
8. **Output**: Posted as a thread reply under the PagerDuty alert message with:
   - What's firing and the blast radius
   - Metrics evidence from Grafana
   - Likely cause
   - Runbook links extracted from AlertManager payload
   - Who is on-call (plain text, no @-mentions to avoid notification spam)
   - Read-only: never acks or resolves the PagerDuty incident

### Key config env vars for PagerDuty

```bash
PAGERDUTY_API_KEY=...           # PagerDuty REST API read-only key (held by the API proxy)
PAGERDUTY_USER_ID=B0XXXXXXXXX          # The PagerDuty Slack bot's Slack user ID (shape: B0XXXXXXXXX)
PAGERDUTY_CHANNELS=C0XXXXXXXXX,C0YYYYYYYYY # Comma-separated Slack channel IDs to watch
PAGERDUTY_SKIP_PATTERNS=...     # Regex patterns for alert titles to skip entirely
PAGERDUTY_DELAY_PATTERNS=...    # Regex patterns for alert titles to hold 5min before triaging
PAGERDUTY_DELAY_SECONDS=300     # Hold duration for delay-pattern alerts
PAGERDUTY_MAX_PER_HOUR=10       # Rate limit: max auto-triages per hour
PAGERDUTY_COOLDOWN_HOURS=1      # Cooldown between triages of same incident
PAGERDUTY_SKIP_CATCHUP=false    # Set true to skip startup scan for missed alerts
```

---

## (g) Config/Env Vars/Secrets Inventory

### Required env vars (from `src/config.ts` and `src/secrets/manifest.ts`)

**Slack / Core:**
```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
REFERENCE_AGENT_BOT_USER_ID=U0XXXXXXXXX         # or discovered via auth.test
```

**Anthropic:**
```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_PRIMARY_MODEL=claude-opus-5        # optional, has default
ANTHROPIC_COMPOSE_MODEL=claude-sonnet-5      # optional, has default
ANTHROPIC_SUMMARIZE_MODEL=                   # optional, defaults to composeModel
```

**GitLab (for code access):**
```bash
GITLAB_TOKEN=glpat-...
GITLAB_HOST=gitlab.example.com               # optional, has default
```

**Third-party APIs (all held by the API proxy, never exposed to the chroot):**
```bash
SENTRY_API_TOKEN=...
JIRA_API_TOKEN=...
JIRA_BASE_URL=https://yourcompany.atlassian.net
NOTION_API_TOKEN=...
GRAFANA_AUTH_TOKEN=...
GRAFANA_BASE_URL=https://grafana.example.com
PAGERDUTY_API_KEY=...
PAGERDUTY_USER_ID=B0XXXXXXXXX
PAGERDUTY_CHANNELS=C0XXXXXXXXX,C0YYYYYYYYY
# ...plus additional third-party vendor tokens (feature flags, marketing, BI/analytics MCPs)
```

**Database:**
```bash
SNAPSHOT_DB_HOST=...                         # Postgres snapshot (default read-only)
SNAPSHOT_DB_PORT=5432
SNAPSHOT_DB_NAME=...
PROD_DB_HOST=...                             # Production DB (production mode only)
PROD_DB_PORT=5432
PROD_DB_NAME=...
PROD_DB_PASSWORD=...
REDSHIFT_HOST=...
REDSHIFT_PORT=5439
REDSHIFT_USER=...
REDSHIFT_PASSWORD=...
ATHENA_S3_OUTPUT_BUCKET=...
ATHENA_DATABASE=...
AWS_DEFAULT_REGION=us-east-1
```

**Operational:**
```bash
ENGINE_NAME=main                             # or tenant handle
MAX_CONCURRENT_CONVERSATIONS=4               # global concurrency limit
RELAY_TOKEN=...                              # shared secret for relay→engine auth
REFERENCE_AGENT_SYSLOG_CHANNEL=C0XXXXXXXXX               # operational alerts channel
FIRST_ADMIN=U0XXXXXXXXX                             # bootstrap admin Slack UID
SECRETS_BACKEND=aws-sm                       # or "env" for local dev
```

### Secrets management

Production: AWS Secrets Manager, two layers per engine:
- `<region>-reference-agent-env` — shared base (all engines)
- `<region>-reference-agent-<engine>-env` — per-engine overrides

EC2 instance profile provides the IAM identity — no static credential stored. The `src/secrets/bootstrap.ts` preloader fetches and injects secrets before the app module is imported.

---

## (h) How to Replicate for SRE-Oncall — Component Checklist

### Must-build components

**1. Relay process** (thin Slack Socket Mode holder)
- Holds the Slack Socket Mode WebSocket (`@slack/bolt` or `@slack/socket-mode`)
- Routes Slack events by channel → HTTP POST to the engine
- Health-polls the engine (GET /health every 5s)
- Posts "restarting" messages when engine is unhealthy
- Hot-reloads routing config without restart
- Handles catch-up on reconnect (POST /catchup to engine)

**2. Engine HTTP server** (port 3940)
- Accepts `POST /event` from relay, acknowledges `202` immediately
- Processes event async
- Exposes `GET /health` (503 until ready, 200 after)
- Exposes `POST /catchup` (startup scan for missed events)

**3. Message router** (`src/index.ts` equivalent)
- Deduplicate by Slack `ts`
- Dispatch to registered modules by priority
- Per-thread serialization (promise chain)
- Global slot semaphore (N concurrent conversations)
- Per-channel cap (optional)
- Handle `/stop` cancellation bypassing the queue

**4. PagerDuty module** (`src/modules/pagerduty/` equivalent)
- `shouldHandle()`: match PD bot Slack UID + configured channels
- `preFilter()`: parse Slack blocks for incident URL + status emoji; drop non-"triggered"
- `frameQuestion()`: `"Triage this PagerDuty incident: <canonical-url>"` (never pass raw title)
- Flap-delay: hold flap-prone alerts N seconds; skip if resolved in window
- Rate limiting: max triages per hour per channel
- Startup catchup scan for missed alerts

**5. State machine** (`src/conversation/state-machine/` equivalent)
- SUMMARIZE → LOAD → INVESTIGATE → REFLECT pipeline
- INVESTIGATE calls Claude Agent SDK `query()` with `--resume <session-id>`
- Session ID persisted to SQLite keyed by `threadTs`
- AbortController per thread for `/stop`
- Status message updated in-place while running

**6. Chroot sandbox** (optional for SRE-Oncall, but important for security)
- Per-thread isolated workspace
- All external API calls go through proxies that hold real credentials
- The Claude Code subprocess gets placeholder credentials only
- In the minimal version: run `claude-code` as a subprocess with limited tool access, hold real API keys in the parent, and proxy all outbound calls

**7. API proxies** (essential)
- PagerDuty proxy: GET /incidents/{id}, GET /incidents/{id}/alerts, GET /oncalls
- Grafana proxy: GET /api/datasources, GET /api/search, POST /api/ds/query
- Slack proxy: conversations.history, conversations.replies (for thread context)
- Anthropic proxy: holds real API key; chroot gets placeholder

**8. Prompt/capability system**
- `prompts/base.md`: role definition and RESEARCH/INVESTIGATE/COMPOSE phases
- `prompts/pagerduty.md`: PD triage playbook (what API calls to make, what to output)
- `prompts/grafana.md`: Grafana capability (datasource map, PromQL guide, read-only rules)
- Profile system: `pagerduty.yaml` profile that pre-loads these capabilities automatically

**9. Session persistence** (SQLite)
- `thread_sessions(thread_ts, session_id, updated_at)` — maps thread → SDK session for `--resume`
- `workspaces(thread_ts, workspace_dir, ...)` — chroot workspace registry
- TTL prune (48h session TTL, 7-day workspace TTL)

**10. Deployment**
- docker-compose on EC2 (or equivalent)
- relay container + engine container + sidecar containers
- Named Docker volume for SQLite + SDK session files
- Secrets from AWS Secrets Manager (or equivalent vault) at startup

### Minimal viable SRE-Oncall architecture

For a hackathon, you can skip the chroot and relay split and run a simplified version:

```
Slack Socket Mode WebSocket (single process)
    │
    ▼
Message router (promise-chain per threadTs, global semaphore)
    │
    ├─ PagerDuty module: match PD bot UID + channel
    │   └─ frameQuestion("Triage this PD incident: <url>")
    │
    ▼
respondInThread:
    1. Acquire semaphore slot
    2. Load session_id from SQLite for threadTs
    3. Fetch thread history via conversations.replies
    4. Build system prompt: base.md + pagerduty.md + grafana.md
    5. Call claude-agent-sdk query() with --resume <session_id>
    6. SDK spawns claude-code subprocess with env vars:
         - PAGERDUTY_API_KEY, GRAFANA_TOKEN (held by parent, proxied)
         - SLACK_BOT_TOKEN (for thread context reads)
    7. Persist new session_id to SQLite
    8. Post response to Slack thread via chat.postMessage
    9. Release semaphore slot
```

### Key security rules from the reference agent worth keeping

- Never pass the raw PD alert title into the framed question — rebuild the URL from validated host + normalized incident ID only (prompt injection defense for production-credentialed turns)
- Hold real API credentials in the parent process; proxy them to the subprocess
- Gate auto-dispatch on PD bot's Slack UID — don't trust message text alone for the trust boundary
- Use per-thread promise-chain serialization to prevent race conditions on rapid follow-ups
- Implement `/stop` that bypasses queueing and aborts via AbortController

### Key files to copy/adapt for SRE-Oncall

| Reference-agent file | Purpose |
|---|---|
| `src/conversation/concurrency.ts` | Promise-chain + semaphore (copy as-is) |
| `src/conversation/cancellation.ts` | AbortController registry per thread |
| `src/modules/pagerduty/parser.ts` | Parse PD Slack blocks → incident ID/URL/status |
| `src/modules/pagerduty/defer.ts` | Flap-delay logic |
| `src/modules/pagerduty/filter.ts` | Dedup + rate limiting |
| `prompts/base.md` | System prompt structure (adapt for SRE context) |
| `prompts/pagerduty.md` | PD triage playbook |
| `prompts/grafana.md` | Grafana access playbook |
| `profiles/pagerduty.yaml` | Profile definition pattern |
| `docs/request-lifetime.md` | Full lifecycle reference |
| `docs/architecture.md` | State machine + sessions reference |

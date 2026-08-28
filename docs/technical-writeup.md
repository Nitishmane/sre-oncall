# Technical write-up

SRE-Oncall is an on-call agent built on the TrueForge harness. A Grafana alert
fires, an orchestrator applies admission policy and starts a harness session,
the agent investigates the live cluster over MCP tools, proposes a fix,
stops at an approval gate, and — once approved — the fix applies and the
recovery is written up. The interesting engineering is less in the pipeline
shape (that part is a fairly standard webhook-to-agent bridge) and more in
what running it against a real harness and a real cluster forced to change.
This document draws on the actual commit history (`git log`), not on the
plan that preceded it — where the two disagree, this describes what's in the
code.

## Architecture

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

Grafana runs inside the kind cluster and posts to the orchestrator on the
host directly — no tunnel on that path. The one tunnel in the system (ngrok,
or Cloudflare Tunnel as a fallback) is reserved for the chat console and
terminates at the orchestrator's `/chat` proxy, never at the harness, whose
local mode has no login of its own.

`orchestrator/` (Express, `node:sqlite`, `@truefoundry/trueforge-sdk`) owns
the webhook, the admission policy, the concurrency control, the Slack bot,
and the `/chat` proxy. `agent/agent.ts` is the agent definition: MCP
attachments, approval policy per attachment, and the model FQN. `skills/` is
a git-backed runbook pack the harness loads directly. `mcp/` is a set of
local bridges (see below). `web/` is the Next.js console. `demo-env/` is a
kind cluster, a fault-injectable demo service, an ArgoCD Application, and a
Terraform module for the Grafana alerting config.

## TrueForge accepts remote MCP servers only

TrueForge's `McpServerManifest` accepts `type: "remote"` — a URL plus
optional header auth — and nothing else. There is no stdio transport. Several
servers this project depends on ship as stdio binaries: the Kubernetes MCP,
the ArgoCD MCP, and the official Notion MCP. Each one runs behind a small
local process that speaks stdio downward and streamable HTTP upward
(`mcp/compose.yaml`, using [supergateway](https://github.com/supercorp-ai/supergateway)
for the stdio ones).

Two servers turned out to speak streamable HTTP natively — Grafana's and
HashiCorp's Terraform server — and wrapping either of those in supergateway
as well was tried first and failed: it means running `docker run` inside a
container that has no docker CLI, which dies with `EPIPE` on the first
request. They run directly instead. The bridge layer exists only for the
servers that actually need it.

This buys one thing worth naming: every MCP endpoint the agent config points
at is now a URL, which is what would let the same agent definition run
against a hosted harness later without changing how it addresses its tools.

## The tool-name problem, and a silent-failure design choice worth flagging

The agent config, the system prompt, and the runbooks were first written
against invented tool names — `list_alert_rules`, `get_pod_logs`,
`get_events` — because they read naturally and nobody had checked the actual
servers yet. Against a live harness, none of them were the real names:
`alerting_manage_rules`, `pods_log` (which takes a `previous` flag — the only
way to see an OOM kill or a panic after the container restarted), and
`events_list`.

The part worth calling out isn't the typo, it's how TrueForge handled it: a
`preloadTools` entry that names a tool the server doesn't have is **ignored
silently**. No error, no warning, nothing in a log. The agent would have run
with a smaller preload list than intended and nobody would have known why
until they noticed the model reaching for tools "cold" more often than
expected. `mcp/README.md` now documents a verification loop —
`curl .../mcp-servers/<name>/tools` — specifically because there's no other
way to catch this class of mistake, and because it needs re-running after any
server image upgrade.

## An hourly rate limit that counted the wrong thing

The alert-admission policy (`orchestrator/src/alerts/filter.ts`,
`orchestrator/src/store.ts`) has two independent counters: a per-incident
cooldown (don't re-triage the same alert for an hour) and an hourly cap
across all incidents (don't let a storm exceed N sessions/hour). The first
version recorded both counters from the same call site — after a session was
successfully started. That's fine for the cooldown, which exists to avoid
re-triaging something already being handled. It's wrong for the hourly cap,
whose entire purpose is bounding load: if the harness is down and every
`startSession` call throws, a counter that only increments on success never
fills up, and the same alert gets retried without bound — in this system's
case, every 30 seconds, indefinitely, for exactly the outage where you'd want
backpressure the most.

The fix, from `34e0f99`, splits the two calls: `recordTriageAttempt` runs
*before* the harness call and feeds the hourly limit; `recordTriage` runs
only after a session actually starts and feeds the per-incident cooldown. A
failed attempt costs the same load-budget as a successful one (correct — it
still hit the harness), but doesn't suppress a legitimate retry on the next
delivery (also correct — a transient failure shouldn't cost an hour). This
was found by running the pipeline against a live cluster, not by reading the
code; it's the kind of asymmetry that looks obviously fine in isolation.

## A turn that pauses reports the same status as a turn that ends

The Slack surface (and the console, through the same translator) needs to
know when a session is actually finished versus merely waiting on a human.
TrueForge's turn-completion event, `turn.done`, is emitted with
`state.status: "done"` in **both** cases — a turn that ran to completion, and
a turn that stopped at an approval gate with the pending gates listed in
`state.requiredActions`. Treating every `"done"` status as "the session is
over" would have closed the Slack thread (and stopped following the session)
on every single remediation, which is exactly the moment a human still needs
to see the pending action.

`orchestrator/src/slack/translator.ts` handles this by checking
`requiredActions` before treating `"done"` as an ending:

```ts
case "turn.done": {
  const state = event.state;
  if (state.status === "done") {
    // A turn that stops at an approval gate is also reported "done", with
    // the pending gates in `requiredActions`. That is a pause, not the end
    // of the session: prompt for the approvals and keep the thread open.
    const pauses = pendingApprovals(state.requiredActions)
      .flatMap((pending) => /* ... */);
    if (state.requiredActions.length > 0) {
      return pauses.length > 0 ? pauses : [{ kind: "status", text: "Waiting on a pending action…" }];
    }
    // only reached when there is nothing left pending: an actual ending
    ...
  }
  ...
}
```

There's a second, related wrinkle: resuming an approval doesn't continue the
same turn, it creates a **new** one (`trueforge.ts`'s `submitApproval` calls
`createTurn` again). A surface that only subscribed to the first turn's
stream would silently stop receiving anything the moment an approval was
resumed. `orchestrator/src/slack/watcher.ts` addresses this by following a
*session* rather than a turn — chaining each turn's stream in order behind a
single translator instance, so the translator's memory of which tool calls
have already been seen (and prompted for) survives across the turn boundary.

## Environment problems that only show up when you actually run it

A cluster of small bugs, each one only visible by running the thing, not by
reading it:

- **macOS binds TrueForge's local port on IPv6 only.** The orchestrator's
  default `TRUEFORGE_API_URL` was `http://127.0.0.1:8790`; nothing could
  connect. The default is now `http://localhost:8790` (`e3cd589`).
- **`kubectl apply -f <directory>` processes files alphabetically.**
  `namespace.yaml` sorted after several files that needed the namespace to
  already exist, so the first bootstrap run failed. The namespace is now
  applied as its own step before the rest of the directory (`34e0f99`).
- **ArgoCD's install manifest exceeds the annotation size `kubectl apply`
  writes for `last-applied-configuration`,** failing with
  `metadata.annotations: Too long`. Switched to a server-side apply
  (`34e0f99`).
- **An empty `.env` value is `""`, not `undefined`.** A `.env` copied
  straight from the template has `SLACK_BOT_TOKEN=`, which a naive
  `z.string().startsWith("xoxb-").optional()` schema rejects, because the
  empty string isn't undefined and isn't a valid token either. `config.ts`
  now preprocesses every optional credential to treat `""` as "not
  configured" (`34e0f99`).
- **Docker Compose does not strip trailing `# comment`s from an `.env` file
  the way Node's `--env-file` does.** A value like
  `KUBECONFIG_PATH=./x  # default` handed the literal string
  `./x  # default` to a container as a volume path. Every comment in
  `.env.example` now lives on its own line (`4ca1671`).
- **`kind`'s kubeconfig points at `127.0.0.1:<random-port>`,** which means
  nothing inside a container — that's the host's loopback, not the
  container's. `mcp/bootstrap-mcp.sh` rewrites the server address to the
  kind node container's address on the kind Docker network before mounting
  the file read-only (`4ca1671`).
- **`next start` ignores a dev-only `--port` flag pattern and binds 3000,**
  which is where the kind cluster's Grafana NodePort is mapped on the host.
  Both `dev` and `start` scripts now read `${PORT:-3100}` (`958f273`).

None of these are deep insights. They're the ordinary cost of an
integration-heavy project, included here because "what changed after actually
running it" is a more honest account of the engineering than the design
docs, which described all of the above as though they'd simply work.

## The trust boundary

Alert labels and annotations are attacker-influenced: anyone who can name a
Kubernetes object, set a pod annotation, or influence what text ends up in an
alert's summary can write into what Grafana sends on the webhook. The
orchestrator does not pass any of that to the model.

`orchestrator/src/alerts/payload.ts` defines `NormalizedAlert` as the only
shape allowed to leave the module: a shape-validated rule UID
(`/^[A-Za-z0-9_.:-]{1,128}$/`), a shape-validated fingerprint, an org ID, and
two timestamps. Everything else — `alertname` used for policy decisions only
and never framed into a prompt text, plus every label and annotation value —
is discarded before the pipeline sees it. `orchestrator/src/prompts.ts`
builds the healing prompt from exactly those four fields:

```ts
export function healingPrompt(alert: NormalizedAlert): string {
  return [
    "A Grafana alert is firing. Heal it.",
    "",
    `alert_rule_uid: ${alert.ruleUid ?? "unknown"}`,
    `fingerprint: ${alert.fingerprint}`,
    `org_id: ${alert.orgId}`,
    "",
    "Do not assume anything about this alert from its identifiers. Start by",
    "fetching the rule and its current state through the Grafana MCP, ...",
  ].join("\n");
}
```

The agent is explicitly instructed not to infer anything from the
identifiers themselves and to re-fetch the real alert — labels, annotations,
current value — through the Grafana MCP. This means the untrusted content
does reach the model eventually, but as MCP tool output the agent chose to
fetch, in a context the system prompt already frames as "investigate, don't
trust," rather than as instructions embedded in the turn's initial message.
It is not a claim that the agent is immune to indirect prompt injection via
alert content — a sufficiently adversarial annotation returned by the
Grafana MCP is still a live concern for what the agent does with what it
reads — only that the *webhook* cannot be used to write arbitrary text
directly into the prompt that starts the session. This narrowing is tested in
`orchestrator/test/payload.test.ts`.

## Two bearers, never interchangeable

`orchestrator/src/auth.ts` implements a single `requireBearer(expected)`
middleware, applied twice with two different secrets:

- `GRAFANA_WEBHOOK_BEARER` gates `/webhook/*` — this is the token Grafana's
  contact point presents, local-to-local, no tunnel involved.
- `TRUEFORGE_BRIDGE_TOKEN` gates `/chat/*`, `/incidents`, and `/approvals` —
  this is the token the Vercel console's server-side route handler presents,
  after it has already checked the browser's GitHub OAuth session.

They are unrelated values. A webhook bearer leaked from a Grafana config (a
lower-value secret, local-to-local) cannot be replayed against the chat
proxy to start a harness session, and vice versa. The comparison itself uses
`timingSafeEqual` with an explicit length check first (`timingSafeEqual`
throws rather than returning `false` on mismatched lengths, which is easy to
get wrong).

The console side of this has its own boundary worth naming:
`web/lib/proxy.ts` is the only thing in the browser-facing app that touches
`TRUEFORGE_BRIDGE_TOKEN`, and it is deliberately narrow — path segments
containing `..`, a slash, a backslash, or a null byte are refused; the
composed upstream URL is re-checked against the configured origin and prefix
*after* parsing (not trusted from string concatenation alone); a non-`http(s)`
base is refused; and of the incoming request's headers, only `accept`,
`content-type`, and `accept-language` are forwarded — never the session
cookie, and never a client-supplied `authorization` header, which would
otherwise let a browser simply state its own bearer and skip the OAuth check
entirely. This file has its own test suite (`web/test/security.test.ts`)
separate from the rest of the app specifically because a bug in it leaks a
credential with full harness access, i.e. the ability to start a session that
can mutate the cluster.

## One owner per thing

ArgoCD owns the demo workload; Terraform owns the Grafana alerting
configuration (rules, contact point, notification policy). Nothing owns
both, and nothing else writes to either. This was a deliberate simplification
over an earlier plan to provision alerting via plain YAML applied alongside
Terraform-managed infrastructure, which would have made two sources of truth
for the same rules. The payoff is that each of the agent's two remediation
paths is unambiguous: "the last deploy caused this" is an ArgoCD rollback,
gated; "the threshold is wrong" is an HCL change with `terraform plan`
output attached to a PR, also gated.

## Concurrency

Two layers, both in `orchestrator/src/concurrency.ts`, ported from a
production internal Slack SRE agent's concurrency pattern:

- **A per-fingerprint promise chain** (`createKeyedQueue`). Work for the same
  alert always runs in the order it arrived, never concurrently — so a
  `firing` and the `resolved` that follows it can't race and end up
  processed out of order.
- **A global semaphore** (`createSemaphore`) capping how many harness
  sessions run at once, independent of how many distinct alerts are firing.

This is orthogonal to, and composed with, the admission policy in
`alerts/filter.ts` (cooldown, hourly cap, flap delay), which decides whether
an alert is even allowed onto the queue in the first place.

## Model provider as configuration

`agent/agent.ts` treats the model as a `provider/model` FQN
(`SRE_ONCALL_MODEL`, e.g. `openai/gpt-5-6-sol`). The provider half
decides both which provider gets registered on the harness and which API-key
env var is read (`apiKeyEnvFor`: `openai` → `OPENAI_API_KEY`, `google-gemini`
→ `GOOGLE_GEMINI_API_KEY`, by the harness's own naming convention). Model
definitions — context length, output limits — come from the harness's own
model-provider catalog rather than being hardcoded, which means they can't go
stale relative to what the harness actually offers. This was provisioned
against both `anthropic/claude-opus-5` and `openai/gpt-5-6-sol` in the same
harness instance with zero code changes (`5b61428`), which is the actual
claim being made here — not that both were used to run a real incident, only
that provisioning and registration work for either.

## Known limitations in the approval boundary

Two gaps a code review found, both real, both left open deliberately and worth
stating rather than glossing.

**A prompt is not an access control.** `alerting_manage_rules` on the Grafana
MCP performs reads *and* create/update/delete behind a single tool name, and
`operation: "list"` is how any investigation begins. Gating it stopped the agent
before it could look at the alert that woke it, so it is ungated and the
operating rules forbid mutation in words. That is an instruction, not a control:
a prompt injection or a model error could still edit an alert rule. The
enforceable fix is argument-aware authorization, or a second read-only Grafana
MCP instance for investigation with the writable one gated — neither of which
the harness supports today.

**`create_or_update_file` can target the deploy branch directly.** The GitHub
attachment ungates branch and file creation so the agent can open a revert pull
request without asking. But nothing in the tool stops it writing straight to
`main`, and ArgoCD auto-syncs `main` — so a mistaken or injected call could
reach production without a pull request at all, bypassing the very gate this
design is built on. The prompt says to open a PR; again, that is an instruction.

The enforceable fix for the second is credential separation: give the agent a
fine-grained token that can create branches and pull requests but cannot push to
`main`, and let branch protection reject anything else. This deployment does not
do that — the agent uses a personal access token with the same rights as the
human — because the demo's own `release-bad.sh` pushes to `main` to simulate a
release, and both identities are the same account. Splitting them is the right
next change, and it is a credentials change rather than a code one.

Neither gap is hypothetical-only: both are reachable by any input the agent
treats as data, which is precisely why the trust boundary above passes
identifiers rather than alert text.

## Testing

66 automated tests: 56 in `orchestrator/test/` (concurrency, the approval
audit log's atomic-claim behavior, the alert-to-session pipeline including
the admission policy, the trust-boundary payload normalization, the HTTP
server's route wiring, and the Slack event translator including the
turn-pause case above) and 10 in `web/test/security.test.ts` (the allowlist's
fail-closed behavior and the proxy's path/header handling). These are unit
and integration tests against in-memory fakes (`:memory:` SQLite, fake
harness clients); they do not exercise a live TrueForge harness, a live
cluster, or a live Slack workspace, though individual pieces of the system
have been (see the honest status table in `docs/demo-script.md`).

## What is not built, or not verified

Said plainly, because the alternative is a submission that reads as more
finished than it is:

- **No real healing session has completed.** There is no funded Anthropic
  API key in this environment. Session and turn *creation* against the
  harness works (it's a synchronous API call), but the agent has never
  actually investigated a real alert, proposed a fix, or been approved
  through a live model call. Every claim above about the pipeline's
  mechanics is verified; the claim that the agent produces a good
  investigation is not, because it has not yet been observed doing so.
- **Slack has never been connected to a real workspace in this project.**
  The bot code, the Block Kit approval rendering, and the translator are
  unit-tested against fakes; `docs/slack-setup.md` describes how to wire it
  up, but that wiring hasn't happened yet.
- **The Notion, ArgoCD, and n8n MCP bridges are unverified against live
  services.** The MCP verification pass documented in `mcp/README.md`
  checked `grafana`, `kubernetes`, and `terraform` against a live harness;
  it did not check `argocd`, `notion`, `n8n-builder`, or `n8n-tools`, all of
  which require credentials (`ARGOCD_API_TOKEN`, `NOTION_TOKEN`,
  `N8N_MCP_AUTH_TOKEN`, `N8N_TOOLS_BEARER`) that aren't set up yet.
- **The console has not been deployed to Vercel.** It runs locally
  (`npm run dev:web`, port 3100) with its auth-wall behavior verified there;
  the GitHub OAuth app, `CHAT_ALLOWLIST`, and the ngrok/Cloudflare tunnel it
  needs in production are not yet configured.
- **No GitHub repository is confirmed public with Qodo installed from this
  checkout.** This worktree has no `git remote` configured, so neither fact
  can be verified from the code alone — see `docs/submission-checklist.md`.
- **The n8n workflow-automation capability (standing tools and the
  agent-built-workflow demo) has no n8n instance running against it yet.**
  The MCP attachment and its approval-gate policy exist in `agent/agent.ts`;
  the n8n container and its exported workflows do not.
- **No PR-based remediation has actually been opened and reviewed.** The
  GitHub MCP attachment exists and is gated the same as everything else;
  no fix PR has been generated by a real session, so there's no Qodo review
  to point at yet either.

# The console

A Next.js app that puts the agent behind an auth wall and shows its incident and
approval history beside the chat. Deploys to Vercel; everything it talks to runs
on the local host, reached through a single authenticated tunnel.

## Why it needs auth at all

The chat can start harness sessions, and a harness session can change a live
cluster. A public chat box would be a public remote-code path into someone's
Kubernetes. So there are two independent layers:

1. **GitHub OAuth + allowlist** (`lib/allowlist.ts`). `CHAT_ALLOWLIST` names the
   GitHub logins that may sign in. It **fails closed** — unset means nobody gets
   in, not everybody. Checked in the Auth.js `signIn` callback, again in
   middleware, and a third time inside the proxy route, which does not delegate
   that decision because it is the thing holding the bearer.
2. **A server-side bridge token** (`app/api/harness/[...path]/route.ts`). The
   browser calls `/api/harness/*` on this origin with its session cookie. The
   route attaches `TRUEFORGE_BRIDGE_TOKEN` and forwards to the orchestrator's
   `/chat` proxy. **The browser never receives the tunnel URL or the token.**

The tunnel terminates at the orchestrator, never at the harness — TrueForge's
local mode has no login of its own, and exposing it directly is the mistake its
own docs warn about.

## What the proxy will not do

`lib/proxy.ts` is small and separately tested because a bug in it leaks a bearer
that grants full harness access:

- path segments containing `..`, `/`, `\`, or a null byte are refused, so a
  request cannot climb out of the upstream's `/chat` prefix
- the composed URL is re-checked against the configured origin and prefix after
  parsing
- a non-http(s) base is refused, so the bearer cannot be sent over another scheme
- only `accept`, `content-type` and `accept-language` are forwarded — **never**
  the session cookie, and never a client-supplied `authorization` header

## Environment

Set these in the Vercel dashboard. None may be `NEXT_PUBLIC_`.

| Variable | What |
|---|---|
| `AUTH_SECRET` | Auth.js session encryption — `openssl rand -hex 32` |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth app credentials |
| `CHAT_ALLOWLIST` | Comma-separated GitHub logins, e.g. `octocat,hubot` |
| `TRUEFORGE_API_URL` | The tunnel, pointing at the orchestrator's `/chat` — e.g. `https://<name>.ngrok-free.app/chat` |
| `TRUEFORGE_BRIDGE_TOKEN` | Must match the orchestrator's value |
| `TRUEFORGE_AGENT_NAME` | Optional; defaults to `sre-oncall` |

Vercel holds only the auth and bridge secrets. **No vendor credentials** —
Grafana, GitHub, Slack, Anthropic and n8n tokens all stay on the local host.

## GitHub OAuth app

At *Settings → Developer settings → OAuth Apps → New*:

- **Homepage URL**: your Vercel URL
- **Authorization callback URL**: `https://<your-app>.vercel.app/api/auth/callback/github`

For local development, register a second app with
`http://localhost:3100/api/auth/callback/github`.

## Running locally

```bash
npm run dev:web     # port 3100 — 3000 is Grafana's, mapped from the kind cluster
```

You still need the orchestrator on `:8080` and the harness on `:8790`. Point
`TRUEFORGE_API_URL` straight at `http://localhost:8080/chat` and skip the tunnel.

## Known advisories

`npm audit` reports moderate DOMPurify issues reaching us through
`@truefoundry/trueforge-ui` → `monaco-editor`. They are transitive and not
fixable without downgrading the UI SDK to `0.0.0`. Worth re-checking when the
SDK updates.

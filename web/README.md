# The console

A Next.js app that puts the agent behind an auth wall and shows its incident and
approval history beside the chat. Deploys to Vercel; everything it talks to runs
on the local host, reached through a single authenticated tunnel.

## Why it needs auth at all

The chat can start harness sessions, and a harness session can change a live
cluster. A public chat box would be a public remote-code path into someone's
Kubernetes. So there are two independent layers:

1. **A username and password** (`lib/credentials.ts`). `CONSOLE_USERS` names the
   accounts that may sign in. It **fails closed** — unset means nobody gets in,
   not everybody. Checked in the Auth.js `authorize` callback, again in
   middleware, and a third time inside the proxy route, which does not delegate
   that decision because it is the thing holding the bearer.
2. **A server-side bridge token** (`app/api/harness/[...path]/route.ts`). The
   browser calls `/api/harness/*` on this origin with its session cookie. The
   route attaches `TRUEFORGE_BRIDGE_TOKEN` and forwards to the orchestrator's
   `/chat` proxy. **The browser never receives the tunnel URL or the token.**

The tunnel terminates at the orchestrator, never at the harness — TrueForge's
local mode has no login of its own, and exposing it directly is the mistake its
own docs warn about.

Credentials rather than an identity provider because of who signs in: the
accounts are issued with the project, and a reviewer should be able to use the
one they were handed without a GitHub account or an org invite.

## Accounts

Passwords are never stored, here or in the environment. `CONSOLE_USERS` holds a
scrypt verifier per account, comma-separated:

```
CONSOLE_USERS="reviewer:scrypt$16384$8$1$<salt-b64>$<hash-b64>,judge:scrypt$..."
```

Mint an entry — the password is prompted for, never passed as an argument, so it
stays out of shell history and the process list:

```bash
npm run console:passwd -- reviewer
```

Press Enter at the prompt to have one generated. It is printed once and cannot
be recovered from the verifier afterwards.

Then paste the `username:verifier` pair into `CONSOLE_USERS` in the Vercel
dashboard. Sessions are JWTs, but the API routes re-check the username against
`CONSOLE_USERS` on every request, so **deleting an account from that variable
locks the holder out immediately** rather than at token expiry.

Usernames are case-insensitive and trimmed. Passwords are neither. A username
may not contain `:` or `,`, which separate the fields.

### What this does and does not protect

scrypt at N=16384 makes each guess cost real CPU, and a failed sign-in never says
whether it was the username or the password that was wrong. There is no attempt
counter: Vercel functions are per-request instances, so an in-memory one would
reset constantly and buy nothing but false confidence. Use the generated
24-character passwords rather than picking your own.

The KDF's cost cuts both ways, and that is the sharper risk here. Each
derivation holds 16 MiB, the sign-in route is public, and an attacker needs no
valid credential to make you spend that — concurrent bad logins are a cheaper
way to exhaust an instance than to guess a password. `lib/credentials.ts`
therefore caps concurrent derivations, which bounds memory per instance. It is
not a rate limit and does not pretend to be one: bounding *attempts* across
instances needs shared state (Redis, Upstash) that this deployment does not
have. If this console ever faces something more hostile than hackathon
reviewers, that is the gap to close first.

Anyone holding an account can drive the agent. What stops a signed-in user from
changing the cluster on a whim is the approval gate downstream, not this login.

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
| `CONSOLE_USERS` | Accounts, as above. **Empty means nobody can sign in.** |
| `TRUEFORGE_API_URL` | The tunnel, pointing at the orchestrator's `/chat` — e.g. `https://<name>.ngrok-free.app/chat` |
| `TRUEFORGE_BRIDGE_TOKEN` | Must match the orchestrator's value |
| `TRUEFORGE_AGENT_NAME` | Optional; defaults to `sre-oncall` |

Vercel holds only the auth and bridge secrets. **No vendor credentials** —
Grafana, GitHub, Slack, OpenAI and n8n tokens all stay on the local host.

Changing `AUTH_SECRET` invalidates every existing session, which is the fastest
way to sign everyone out at once.

## Why the auth config is split in two

`auth.config.ts` holds everything with no Node-only dependencies;
`auth.ts` adds the credentials provider on top. Middleware builds its own
instance from the config alone, because it runs on the edge runtime, where
`node:crypto` — and so scrypt — does not exist. Middleware only needs to verify
the session cookie, which `AUTH_SECRET` is enough for.

## Running locally

```bash
npm run dev:web     # port 3100 — 3000 is Grafana's, mapped from the kind cluster
```

Export the variables above in that shell first; `CONSOLE_USERS` unset means you
will not be able to sign in to your own dev server.

You still need the orchestrator on `:8080` and the harness on `:8790`. Point
`TRUEFORGE_API_URL` straight at `http://localhost:8080/chat` and skip the tunnel.

## Known advisories

`npm audit` reports moderate DOMPurify issues reaching us through
`@truefoundry/trueforge-ui` → `monaco-editor`. They are transitive and not
fixable without downgrading the UI SDK to `0.0.0`. Worth re-checking when the
SDK updates.

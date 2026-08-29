# The explainer page

`index.html` — one self-contained static page describing the project: the two
agents, which harness and model each runs on, which MCP servers they hold, where
the approval gates are, and what has actually been verified versus what is
scaffolding.

It is what gets submitted.

## Deploying

No build step, no framework, no dependencies, and **no environment variables**.

On Vercel: Root Directory `web`, Framework Preset **Other**, Build Command
empty, Output Directory `.`.

That is the whole configuration. The page holds no secrets and needs none,
which is the point — everything that touches a cluster or carries a vendor
credential runs on the local host and is never reachable from here.

To look at it locally, open the file. There is nothing to serve.

## Why it is not an app

This directory used to hold a Next.js chat console: GitHub OAuth, then
username/password, a server-side proxy holding a bridge token, and an incident
panel — all so a browser could drive the harness through a tunnel.

That was removed deliberately. Once the page stopped needing to reach the
harness, every reason for the stack went with it: no auth, no proxy, no session,
no secrets, nothing to attack. A document should be a document.

The tunnel and `TRUEFORGE_BRIDGE_TOKEN` existed only to serve that console. The
orchestrator's `/chat` proxy now has no caller — worth removing separately
rather than leaving as unexplained dead code.

## Keeping it honest

The page states specific claims about tool gating, model, and agent
configuration. Those come from `agent/agent.ts`, which is the source of truth —
if an attachment's `requireApprovalForTools` changes, this page is wrong until
someone updates it.

The "what is real, and what is not" section exists because a demo that overstates
itself is worse than a smaller one that does not. Keep it accurate even when the
accurate answer is less impressive; it is the section a reviewer trusts the rest
of the page by.

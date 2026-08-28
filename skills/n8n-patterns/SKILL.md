---
name: n8n-patterns
description: Build-patterns for n8n workflows — how to shape a trigger, handle failure, and expose a workflow as an MCP tool the harness can call. Load the pattern that matches the requirement's trigger before designing; load the spec template when writing a requirement back to a person for agreement.
---

# n8n build patterns

Pick the pattern by **what starts the workflow**, because the trigger decides
almost everything else: how failure is handled, whether the run is idempotent,
and whether anyone finds out when it breaks.

| What the person described | Pattern |
|---|---|
| "every morning", "once an hour", "check for new X" | `patterns/scheduled-poll.md` |
| "when X happens in <other system>", a callback, an inbound event | `patterns/webhook-ingest.md` |
| "so the agent can do X", a tool for an AI to call | `patterns/mcp-tool.md` |

Then, always: `patterns/error-handling.md`. It is not optional and it is not a
pattern you choose between — every workflow above needs it, and it is the part
people forget to ask for.

`templates/workflow-spec.md` is the shape to read a requirement back in before
you build. Agreement on six lines is much cheaper than agreement on a built
workflow.

## Rules that apply to every pattern

**Look the node up. Every time.** n8n node types are exact strings — right down
to the package prefix and the capitalisation — and a wrong one produces a
workflow that imports cleanly, opens in the editor, and does nothing. There is
no error. `search_nodes` then `get_node` before you use anything, and take the
`typeVersion` from what `get_node` reports rather than from memory or from an
example you saw.

**Prefer the specific node to an HTTP Request node.** The Slack node carries
auth, retries, rate-limit handling and pagination that you would otherwise write
by hand and get subtly wrong. Reach for HTTP Request when no node exists, and
say out loud that is what you are doing.

**Validate before you create, and again after.** `validate_workflow` on the
draft, then `n8n_validate_workflow` by ID once it exists. The second one catches
things the first cannot, because the instance knows which credentials actually
exist.

**Create inactive; never activate on your own initiative.** `n8n_create_workflow`
always creates inactive, which is why it needs no approval. Activation is what
makes a workflow fire at real people, it happens through
`n8n_update_partial_workflow` / `n8n_update_full_workflow`, and it is gated. A
person asking you to build something has not asked you to switch it on.

**Credentials are referenced, never supplied.** Ask for the credential *name*
that exists in the instance. Never ask for a token value, and never accept one
if it is offered — a secret pasted into a chat is a secret in a transcript.

**Name it for what it does.** `harness-selftest` and `notify-oncall` are
findable in a list of two hundred workflows six months from now.
`My workflow 4` is not.

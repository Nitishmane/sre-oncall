# Exposing a workflow as an MCP tool

**Use when** the requirement is "so the agent can do X" — the caller is a model,
not a person and not a schedule. The workflow becomes a tool in some agent's
toolset.

This is the pattern with the worst failure mode in n8n, because getting it wrong
produces **no error anywhere**. The workflow imports, opens in the editor, looks
correct, and exposes nothing. The endpoint returns 404 and the agent simply
never sees the tool. Three workflows in this repo were broken this way for
their entire existence before anyone checked.

So build it from the known-good shape below rather than from memory.

## The shape

Two nodes. The trigger, and one tool node attached to it.

```
MCP Server Trigger  (@n8n/n8n-nodes-langchain.mcpTrigger, typeVersion 2)
        ▲
        │  ai_tool
        │
harness_selftest    (@n8n/n8n-nodes-langchain.toolCode, typeVersion 1.3)
```

`n8n/workflows/harness-selftest.json` in this repo is exactly this and is known
to work. Copy its structure.

### The three things that silently break it

**1. The node type must carry the `@n8n/` package prefix and the exact
capitalisation.**

```
@n8n/n8n-nodes-langchain.mcpTrigger     ← correct
n8n-nodes-langchain.mcptrigger          ← imports fine, exposes nothing
```

**2. The connection type is `ai_tool`, not `main`.** Sub-nodes attach *upward*
to their root node over a typed connection, and the connection is declared on
the sub-node:

```json
"connections": {
  "harness_selftest": {
    "ai_tool": [[{ "node": "MCP Server Trigger", "type": "ai_tool", "index": 0 }]]
  }
}
```

Wiring it over `main` produces a workflow that looks connected on the canvas and
registers no tools.

**3. The workflow must be active.** n8n registers the path only when a workflow
carrying the trigger is switched on. Until then the endpoint returns
`"The requested webhook POST <path> is not registered"` — a 404 that reads like
a misconfiguration and is really just "not activated yet".

Activation is gated. Ask, explaining that the tool does not exist until it
happens.

## Naming and the tool contract

On `toolCode` v1.3 the **node name becomes the tool name**. Name the node what
you want the model to call. Use the shape the rest of the toolset uses —
lowercase, underscores.

The node's `description` is the entire interface. A model chooses this tool over
every other tool it has based on that one string, so write it for that decision:
what it does, what it needs, and — where it matters — what it does *not* do.

```
"Send an urgent notification to the on-call engineer via Slack and SMS.
 Use for P1 and P2 only; P3 goes to the ticket queue instead."
```

State side effects explicitly. A tool that pages a human at 3am should say so in
its description, because the model is choosing whether to reach for it.

## Auth

The trigger takes `authentication: "bearerAuth"` plus a credential of type
`httpBearerAuth`. The calling agent's MCP server config sends the matching
`Authorization: Bearer` header.

Bind to localhost and treat the bearer as the only gate. Do not put an
unauthenticated MCP trigger on a reachable interface: every tool on that path
becomes callable by anyone who finds it.

## Verify it actually registered

Never assume. The whole point of this page is that this pattern fails silently.

```bash
npm run ask -- <agent> "Call <tool_name> with <some input>"
```

That stops at the approval gate and names the tool it resolved, which proves
discovery worked. Add `--approve` to see the workflow's real output come back.

If the tool does not appear in the agent's toolset, work back through the three
failure modes above in order — type string, connection type, activation. It is
always one of them.

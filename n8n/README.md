# n8n Workflow Automation for SRE-Oncall

This directory contains the self-hosted n8n instance (workflow execution engine) and the MCP builder server (czlonkowski/n8n-mcp) that exposes n8n as an MCP server to the TrueForge agent.

## Architecture

Two services:
- **n8n** (port 5678): The editor UI, workflow engine, and MCP Server Trigger endpoint
- **n8n-mcp** (port 8105): The czlonkowski builder MCP server that lets the agent build workflows from natural language

## Bringing Up the Containers

### 1. Prerequisites

Ensure you have populated the required env vars in `.env`:

```bash
# n8n API key (generate from n8n UI: Settings → API → Create API Key)
N8N_API_KEY=

# MCP auth token (min 32 chars; generate: openssl rand -hex 32)
N8N_MCP_AUTH_TOKEN=

# Bearer token for MCP Server Trigger tools (min 32 chars; generate: openssl rand -hex 32)
N8N_TOOLS_BEARER=
```

### 2. Start the Services

```bash
docker compose -f n8n/compose.yaml --env-file .env up -d
```

Wait for both containers to be healthy:

```bash
docker compose -f n8n/compose.yaml logs -f n8n
docker compose -f n8n/compose.yaml logs -f n8n-mcp
```

n8n is ready when you see:
```
n8n ready on 127.0.0.1:5678
```

### 3. Verify n8n is Running

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5678/
```

Should return `200`.

## Setting Up n8n for MCP Integration

### 3a. Create the API Key

The n8n API key is needed by the n8n-mcp builder to manage workflows.

1. Open the n8n editor: `http://127.0.0.1:5678/`
2. Go to **Settings** (bottom left, user menu)
3. Click **API** in the left sidebar
4. Click **Create API Key**
5. Copy the key and paste it into your `.env` as `N8N_API_KEY=<key>`
6. Restart the n8n-mcp container:
   ```bash
   docker compose -f n8n/compose.yaml --env-file .env restart n8n-mcp
   ```

### 3b. Import the Three Standing Workflows

The three MCP Server Trigger workflows are in `n8n/workflows/`:
- `notify-oncall.json` — Send notification to on-call engineer
- `create-incident-ticket.json` — Create incident ticket
- `escalate-incident.json` — Escalate incident through the chain

Each workflow:
- Uses an **MCP Server Trigger** node on path `/mcp/sre-oncall`
- Exposes a tool to the agent
- Contains placeholder logic (no real credentials, no hardcoded webhook URLs)

**To import:**

1. In n8n UI, click **+ New** → **Import from file**
2. Select `n8n/workflows/notify-oncall.json`
3. Click **Import** → **Save** → **Activate**
4. Repeat for the other two workflows

After activation, n8n generates production MCP Server Trigger URLs. Check the workflow's MCP Server Trigger node for the endpoint.

### 3c. Set the MCP Server Trigger Bearer Token

Each workflow's MCP Server Trigger node needs the bearer token for authentication:

1. Open one of the imported workflows (e.g., notify-oncall)
2. Click the **MCP Server Trigger** node
3. In the right panel, look for **Authentication** or **Bearer Token**
4. Paste the value of `N8N_TOOLS_BEARER` from your `.env`
5. Click **Save**
6. Repeat for the other two workflows

## If you already have a `.env`

`MCP_N8N_BUILDER_URL` shipped pointing at port **3000**, which is Grafana's.
Fixing the fallback in `agent/agent.ts` is not enough — the environment wins
over the fallback, so an existing `.env` keeps registering the wrong port and
`npm run provision` cheerfully reports success while pointing the agent at a
Grafana that will never speak MCP to it. Check the value, then re-provision:

```bash
grep MCP_N8N_BUILDER_URL .env     # must be http://127.0.0.1:8105/mcp
npm run provision
```

## Verifying the n8n-mcp Builder

Ask the server what it has, rather than trusting this file:

```bash
set -a && . ./.env && set +a
mcp/probe-tools.sh 8105 "$N8N_MCP_AUTH_TOKEN"
```

That matters more than it sounds. The harness **silently ignores** a
`preloadTools` entry in `agent/agent.ts` that does not match a real tool — no
warning, no error, just an agent that quietly cannot do the thing you thought
you gave it. Never copy a tool name out of documentation; read it off the
server.

### What the builder exposes

The toolset splits in two, and which half you get depends on `N8N_API_KEY`.

**Without an API key — 7 documentation tools** (verified 2026-08-27 against
`ghcr.io/czlonkowski/n8n-mcp:latest`):

```
get_node  get_template  search_nodes  search_templates
tools_documentation  validate_node  validate_workflow
```

This is enough for the agent to *design* a workflow: find the right nodes, pull
a template, and validate the result before anyone commits to it.

**With an API key — 18 more `n8n_*` management tools** that reach into the
running instance, among them `n8n_create_workflow`, `n8n_update_partial_workflow`,
`n8n_delete_workflow`, `n8n_list_workflows` and `n8n_health_check`.

Note the `n8n_` prefix on every one of them. There is no bare `create_workflow`
or `activate_workflow`; activation happens through a workflow update. The
compose file leaves `N8N_API_KEY` optional precisely so the documentation half
works before anyone has minted a key.

## Verifying the MCP Server Trigger Tools

The three standing workflows (notify-oncall, create-incident-ticket, escalate-incident) expose their tools at:

```
http://127.0.0.1:5678/mcp/sre-oncall
```

Authentication: `Authorization: Bearer ${N8N_TOOLS_BEARER}`

### Test the Tool List

Same handshake as the builder, so the same script works — the trigger just
lives on n8n's own port under a path rather than on a bridge port:

```bash
set -a && . ./.env && set +a
mcp/probe-tools.sh 5678 "$N8N_TOOLS_BEARER"   # see caveat below
```

The script targets `/mcp` on the port you give it, so for the trigger's
`/mcp/sre-oncall` path you currently need the handshake by hand. The important
part is that it is a **JSON-RPC POST handshake, not a REST GET** — there is no
`/tools/list` URL to curl on any MCP server.

Expected tool names once the three workflows are imported *and activated*:
`notify-oncall`, `create-incident-ticket`, `escalate-incident`.

**Until then this endpoint returns 404** — `"The requested webhook POST
sre-oncall is not registered"`. That is the expected state of a fresh instance,
not a misconfiguration: n8n only registers the path when a workflow carrying
that trigger is switched on.

## Stopping the Containers

```bash
docker compose -f n8n/compose.yaml down
```

To also remove the persistent volume (⚠️ deletes all workflows):

```bash
docker compose -f n8n/compose.yaml down -v
```

## Troubleshooting

### n8n-mcp Cannot Reach n8n

**Error:** `connect ECONNREFUSED 127.0.0.1:5678` or similar

**Fix:** Ensure `host.docker.internal:host-gateway` is in the n8n-mcp `extra_hosts`. The container must reach the host's port 5678. Verify with:

```bash
docker exec <n8n-mcp-container-id> curl -s http://host.docker.internal:5678/ | head
```

### API Key Issues

**Error:** `401 Unauthorized` when the builder tries to create a workflow

**Fix:** The n8n API key in the builder container's `N8N_API_KEY` env var is stale or wrong:

1. Generate a fresh key in n8n UI
2. Update `.env`
3. `docker compose -f n8n/compose.yaml --env-file .env restart n8n-mcp`

### MCP Auth Bearer Token Invalid

**Error:** `401` from the builder or trigger tools

**Fix:** Ensure `N8N_MCP_AUTH_TOKEN` and `N8N_TOOLS_BEARER` are set and at least 32 characters:

```bash
openssl rand -hex 32
```

## Integration with TrueForge Agent

The agent reads the n8n MCP servers from `agent/agent.ts`:

```typescript
{
  manifest: {
    name: "n8n-builder",
    type: "remote",
    url: env("MCP_N8N_BUILDER_URL") || "http://127.0.0.1:8105/mcp",
    auth: headerAuth({ Authorization: `Bearer ${env("N8N_MCP_AUTH_TOKEN")}` }),
  },
  attachment: {
    name: "n8n-builder",
    enableTools: ["@all"],
    requireApprovalForTools: ["@write", "@destructive"],
  },
  requiresEnv: ["N8N_MCP_AUTH_TOKEN"],
},
{
  manifest: {
    name: "n8n-tools",
    type: "remote",
    url: env("MCP_N8N_TOOLS_URL") || "http://127.0.0.1:5678/mcp/sre-oncall",
    auth: headerAuth({ Authorization: `Bearer ${env("N8N_TOOLS_BEARER")}` }),
  },
  attachment: {
    name: "n8n-tools",
    enableTools: ["@all"],
    requireApprovalForTools: ["@all"],
  },
  requiresEnv: ["N8N_TOOLS_BEARER"],
},
```

After bringing up n8n and importing the workflows, run:

```bash
npm run provision
```

to register the MCP servers with the TrueForge harness.

## Next Steps

1. Activate all three standing workflows in n8n
2. Verify the builder and trigger tools are listed correctly
3. Add the agent's ability to invoke the builder tools (via `npm run provision`)
4. Test: ask the agent to "create a workflow that..."

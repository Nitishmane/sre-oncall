# MCP servers: bridging stdio to the harness

## The constraint

TrueForge's MCP server manifest accepts **`type: "remote"` only** — a URL plus
optional header auth:

```ts
interface McpServerManifest {
  name: string;
  type: "remote";        // the only value
  url: string;           // required
  description: string;
  auth?: { type: "header"; headers: Record<string, string> };
}
```

There is no stdio transport. Several servers we depend on — Kubernetes, ArgoCD,
Terraform, Notion — ship as stdio binaries, so each one is fronted by a local
process that speaks stdio downward and streamable HTTP upward.

This costs one container per stdio server and buys a uniform interface. It also
means every MCP endpoint is a URL the agent config can point at, which is what
lets the same agent definition run against a hosted harness later.

## Port map

| MCP server | Transport as shipped | Bridge port | Env override |
|---|---|---|---|
| grafana | HTTP (`mcp-grafana --transport http`) | 8000 | `MCP_GRAFANA_URL` |
| kubernetes | stdio | 8001 | `MCP_KUBERNETES_URL` |
| argocd | stdio | 8002 | `MCP_ARGOCD_URL` |
| terraform | stdio | 8003 | `MCP_TERRAFORM_URL` |
| notion | stdio | 8004 | `MCP_NOTION_URL` |
| n8n-builder | HTTP natively | 3000 | `MCP_N8N_BUILDER_URL` |
| n8n-tools | HTTP natively (MCP Server Trigger) | 5678 | `MCP_N8N_TOOLS_URL` |
| github | cloud, no bridge | — | — |

## Running the bridges

`docker compose -f mcp/compose.yaml up -d` starts every bridge whose credentials
are present in `.env`. Each uses [supergateway](https://github.com/supercorp-ai/supergateway),
which wraps a stdio MCP server as streamable HTTP.

The bridges bind to `127.0.0.1` only. They hold real cluster and SaaS
credentials and must never be exposed — not on the ngrok tunnel, not on the LAN.
The only thing the tunnel carries is the orchestrator's authenticated `/chat`
proxy.

## Verifying a bridge

```bash
curl -s localhost:8001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -40
```

Then confirm the harness itself can see the tools:

```bash
curl -s localhost:8790/api/settings/mcp-servers/kubernetes/tools | jq '.data[].name'
```

If the harness lists zero tools, the bridge is up but the underlying server
failed to start — check `docker compose logs mcp-kubernetes`.

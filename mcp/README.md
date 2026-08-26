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
| grafana | HTTP (`mcp-grafana --transport http`) | 8100 | `MCP_GRAFANA_URL` |
| kubernetes | stdio | 8101 | `MCP_KUBERNETES_URL` |
| argocd | stdio | 8102 | `MCP_ARGOCD_URL` |
| terraform | streamable HTTP natively — no bridge | 8103 | `MCP_TERRAFORM_URL` |
| notion | stdio | 8104 | `MCP_NOTION_URL` |
| n8n-builder | HTTP natively | 3000 | `MCP_N8N_BUILDER_URL` |
| n8n-tools | HTTP natively (MCP Server Trigger) | 5678 | `MCP_N8N_TOOLS_URL` |
| github | cloud, no bridge | — | — |

## Running the bridges

```bash
./mcp/bootstrap-mcp.sh
```

It starts every bridge whose credentials are present in `.env`, and prepares the
one thing that needs preparing first: **kind writes a kubeconfig whose server is
`https://127.0.0.1:<random-port>`, which is meaningless inside a container**, so
the script rewrites it to the node container's address on the kind network and
mounts that copy read-only.

Bridges that wrap a stdio server use
[supergateway](https://github.com/supercorp-ai/supergateway). Servers that speak
streamable HTTP already (grafana, terraform, n8n) run directly — wrapping one of
those in supergateway means nesting `docker run` inside a container with no
docker CLI, which fails with `EPIPE` as soon as a request arrives.

The bridges bind to `127.0.0.1` only. They hold real cluster and SaaS
credentials and must never be exposed — not on the ngrok tunnel, not on the LAN.
The only thing the tunnel carries is the orchestrator's authenticated `/chat`
proxy.

## Verifying

Ask the harness what it can see — that is the integration point that matters,
and it exercises the whole chain:

```bash
for s in grafana kubernetes terraform; do
  printf '%-12s ' "$s"
  curl -s -m 40 "http://localhost:8790/api/v1/mcp-servers/$s/tools" \
    | jq -r 'if .data then "\(.data|length) tools" else .error.message end'
done
```

A healthy local setup reports roughly:

```
grafana      65 tools
kubernetes   20 tools
terraform     9 tools
```

An error here means the bridge is up but the server behind it failed — check
`docker compose -f mcp/compose.yaml logs <service>`. Zero tools with no error
usually means the URL registered on the harness is stale: re-run
`npm run provision` after changing any port.

## Tool names are not guessable

Each server names its tools its own way, and a `preloadTools` entry that matches
nothing is ignored silently rather than erroring. The names in `agent/agent.ts`
and in the runbooks were taken from live servers, not from documentation:

| Server | Examples |
|---|---|
| grafana | `alerting_manage_rules`, `query_prometheus`, `query_prometheus_histogram`, `query_loki_logs`, `get_panel_image` |
| kubernetes | `pods_list_in_namespace`, `pods_get`, `pods_log` (takes `previous`), `events_list`, `resources_create_or_update`, `resources_scale` |

Re-check them with the loop above after upgrading a server image.

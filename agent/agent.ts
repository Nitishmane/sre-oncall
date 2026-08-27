import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The SRE-Oncall agent definition, plus the MCP servers and skills it depends on.
 *
 * NOTE on transports: TrueForge's `McpServerManifest` accepts `type: "remote"`
 * only — a URL plus optional header auth. Servers that ship as stdio binaries
 * (kubernetes, argocd, terraform, notion) are therefore fronted by a local
 * stdio→HTTP bridge; see `mcp/README.md`. Each entry below points at the bridge
 * port, not at the binary.
 */

export interface McpDefinition {
  manifest: TrueForgeApi.McpServerManifest;
  /** How the agent may use it: which tools, and which of them need approval. */
  attachment: TrueForgeApi.McpServer;
  /** Set when this server is optional — provisioning skips it if unconfigured. */
  requiresEnv?: string[];
}

const env = (name: string): string => process.env[name] ?? "";

function headerAuth(headers: Record<string, string>): TrueForgeApi.McpServerManifestAuth {
  return { type: "header", headers };
}

export const mcpServers: McpDefinition[] = [
  {
    manifest: {
      name: "grafana",
      type: "remote",
      description:
        "Grafana: alert rules and state history, Prometheus/PromQL queries, Loki log and Kubernetes-event queries, dashboards, panel rendering, silences and annotations.",
      url: env("MCP_GRAFANA_URL") || "http://127.0.0.1:8100/mcp",
    },
    attachment: {
      name: "grafana",
      enableTools: ["@all"],
      // Silences and annotations change what other humans see. Gate them.
      requireApprovalForTools: ["@write", "@destructive"],
      // Verified against a live mcp/grafana server: these are the exact tool
      // names it exposes. A preload entry that does not match a real tool is
      // silently ignored, which is worse than an error.
      preloadTools: ["alerting_manage_rules", "query_prometheus", "query_loki_logs"],
    },
  },
  {
    manifest: {
      name: "kubernetes",
      type: "remote",
      description:
        "Live Kubernetes access to the demo cluster: pod and deployment status, recent events, container logs (including previous containers after a restart), crash diagnostics, rollout history.",
      url: env("MCP_KUBERNETES_URL") || "http://127.0.0.1:8101/mcp",
    },
    attachment: {
      name: "kubernetes",
      // Reading is free; anything that mutates the cluster stops for a human.
      enableTools: ["@all"],
      requireApprovalForTools: ["@write", "@destructive"],
      // Verified against a live kubernetes-mcp-server. Note `pods_log` takes a
      // `previous` flag — that is where an OOM kill or a panic is visible.
      preloadTools: ["events_list", "pods_list_in_namespace", "pods_log"],
    },
  },
  {
    manifest: {
      name: "argocd",
      type: "remote",
      description:
        "ArgoCD: application sync status, deploy history, and rollback. Use it to answer 'what changed just before this started?'.",
      url: env("MCP_ARGOCD_URL") || "http://127.0.0.1:8102/mcp",
    },
    attachment: {
      name: "argocd",
      enableTools: ["@all"],
      // A rollback is a production change: always gated.
      requireApprovalForTools: ["@write", "@destructive"],
    },
    requiresEnv: ["ARGOCD_API_TOKEN"],
  },
  {
    manifest: {
      name: "terraform",
      type: "remote",
      description:
        "Terraform registry and provider documentation, plus plan/validate for the demo infrastructure module. Use it when the fix belongs in infrastructure-as-code rather than in a manifest.",
      url: env("MCP_TERRAFORM_URL") || "http://127.0.0.1:8103/mcp",
    },
    attachment: {
      name: "terraform",
      enableTools: ["@all"],
      requireApprovalForTools: ["@write", "@destructive"],
    },
  },
  {
    manifest: {
      name: "github",
      type: "remote",
      description:
        "GitHub: read the demo service repository, inspect the commits in a release, and open pull requests carrying a proposed fix.",
      url: "https://api.githubcopilot.com/mcp/",
      auth: headerAuth({ Authorization: `Bearer ${env("GITHUB_TOKEN")}` }),
    },
    attachment: {
      name: "github",
      enableTools: ["@all"],
      // Opening a PR is fine unattended; merging one is not.
      requireApprovalForTools: ["@write", "@destructive"],
    },
    requiresEnv: ["GITHUB_TOKEN"],
  },
  {
    manifest: {
      name: "notion",
      type: "remote",
      description:
        "Notion: create and update pages in the Postmortems database (incident, date, severity, status, MTTR, root cause, timeline, follow-ups).",
      url: env("MCP_NOTION_URL") || "http://127.0.0.1:8104/mcp",
    },
    attachment: {
      name: "notion",
      enableTools: ["@all"],
      requireApprovalForTools: ["@destructive"],
    },
    requiresEnv: ["NOTION_TOKEN"],
  },
  {
    manifest: {
      name: "n8n-builder",
      type: "remote",
      description:
        "Build n8n workflows from a natural-language description: search nodes, fetch templates, validate a workflow, then create and activate it.",
      url: env("MCP_N8N_BUILDER_URL") || "http://127.0.0.1:8105/mcp",
      auth: headerAuth({ Authorization: `Bearer ${env("N8N_MCP_AUTH_TOKEN")}` }),
    },
    attachment: {
      name: "n8n-builder",
      enableTools: ["@all"],
      // Activating a workflow makes it fire at real people. Always gated.
      requireApprovalForTools: ["@write", "@destructive"],
    },
    requiresEnv: ["N8N_MCP_AUTH_TOKEN"],
  },
  {
    manifest: {
      name: "n8n-tools",
      type: "remote",
      description:
        "Standing on-call automations exposed as tools: notify-oncall, create-incident-ticket, escalate-incident.",
      url: env("MCP_N8N_TOOLS_URL") || "http://127.0.0.1:5678/mcp/sre-oncall",
      auth: headerAuth({ Authorization: `Bearer ${env("N8N_TOOLS_BEARER")}` }),
    },
    attachment: {
      name: "n8n-tools",
      enableTools: ["@all"],
      // Every one of these pages a human.
      requireApprovalForTools: ["@all"],
    },
    requiresEnv: ["N8N_TOOLS_BEARER"],
  },
];

export const skills: TrueForgeApi.SkillManifest[] = [
  {
    name: "sre-runbooks",
    type: "git",
    description:
      "Runbooks for the failure signatures this platform actually produces — crashloop/OOM, high error rate, bad deploy, connection-pool exhaustion — plus the triage-report, postmortem and handoff formats.",
    url: env("SKILLS_REPO_URL") || "https://github.com/OWNER/sre-oncall",
    ref: env("SKILLS_REPO_REF") || "main",
    path: "skills/sre-runbooks",
  },
];

/**
 * Model FQN for the agent's main loop, as `provider/model`. The provider half is
 * authoritative: it decides which model provider gets registered on the harness
 * and which API key is read. Switching vendors is therefore a change to this one
 * value plus the matching key — no code change.
 *
 *   SRE_ONCALL_MODEL=openai/gpt-5-6-sol      OPENAI_API_KEY=...
 *   SRE_ONCALL_MODEL=anthropic/claude-opus-5 ANTHROPIC_API_KEY=...
 *
 * Run `npm run provision -- --list-models` to see what this harness offers.
 */
export function primaryModel(): string {
  return env("SRE_ONCALL_MODEL") || "anthropic/claude-opus-5";
}

/**
 * A cheaper model for summarising. Defaults to the primary model rather than to
 * a fixed second name, so switching provider cannot leave a stale cross-vendor
 * reference behind.
 */
export function summaryModel(): string {
  return env("SRE_ONCALL_SUMMARY_MODEL") || primaryModel();
}

/** Provider half of the model FQN — e.g. `openai`, `anthropic`, `google-gemini`. */
export function providerOf(modelFqn: string): string {
  const [provider] = modelFqn.split("/");
  if (provider === undefined || provider === "" || !modelFqn.includes("/")) {
    throw new Error(
      `Model "${modelFqn}" is not a provider/model FQN. Example: openai/gpt-5-6-sol`,
    );
  }
  return provider;
}

/**
 * Env var holding the API key for a provider, by the harness's own naming:
 * `openai` → OPENAI_API_KEY, `google-gemini` → GOOGLE_GEMINI_API_KEY.
 */
export function apiKeyEnvFor(provider: string): string {
  return `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

/** Every model this project needs configured on the harness. */
export function modelNames(): string[] {
  return [...new Set([primaryModel(), summaryModel()])];
}

export function agentSpec(): TrueForgeApi.AgentSpec {
  const instructions = readFileSync(join(here, "prompts", "base.md"), "utf8");
  const configured = mcpServers.filter(isConfigured);

  return {
    model: {
      name: primaryModel(),
      params: { temperature: 0 },
    },
    instructions,
    config: {
      // Skills need a sandbox; the agent also drafts postmortems and scratch
      // analysis scripts there.
      sandbox: { enabled: true, fileDownloads: true },
      // Incidents are long. Give the loop room, but not unbounded room.
      iterationLimit: 200,
    },
    mcpServers: configured.map((server) => server.attachment),
    skills: skills.map((skill) => ({ name: skill.name })),
  };
}

/** An optional MCP server is provisioned only when its credentials are present. */
export function isConfigured(server: McpDefinition): boolean {
  return (server.requiresEnv ?? []).every((name) => (process.env[name] ?? "") !== "");
}

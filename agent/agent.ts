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
      // Gated by name rather than by `@write`, because this server bundles
      // reads and writes into single tools: `alerting_manage_rules` is how you
      // *read* a rule (`operation: "list"`) as well as how you delete one, so
      // `@write` stopped the agent on the very first step of every
      // investigation — it could not look at the alert that woke it.
      //
      // The trade-off is explicit: rule reads are ungated, so the operating
      // rules forbid mutating alert rules in words rather than in policy.
      // Everything that changes what other humans see, or that can reach
      // arbitrary Grafana endpoints, stays gated.
      // `grafana_api_request` reaches ANY Grafana endpoint, so it cannot be
      // ungated — and gating it blocked a postmortem that only wanted to GET
      // an alert rule. Removing it is the way out: everything the agent needs
      // is available through a specific tool that is gated on its own merits,
      // and a catch-all that can do anything is impossible to gate sensibly.
      disableTools: ["grafana_api_request"],
      requireApprovalForTools: [
        "alerting_manage_routing",
        "create_annotation",
        "create_datasource",
        "create_folder",
        "create_incident",
        "add_activity_to_incident",
        "create_snapshot",
        "delete_snapshot",
        "install_plugin",
        "update_dashboard",
        "create_dashboard",
        "delete_dashboard",
        "delete_datasource",
        "update_datasource",
        // Deliberately NOT "@destructive": that group classifies
        // `alerting_manage_rules` by what it *can* do, so it re-gated the
        // read that every investigation begins with. Gating by name costs a
        // list to maintain and buys an agent that can actually investigate.
        // A name this server does not expose is inert here, so the list errs
        // long on purpose.
      ],
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
      // Verified against the running server's tools/list — a name that does not
      // exist is silently dropped, so a typo here degrades the agent in silence.
      preloadTools: ["list_applications", "get_application", "get_application_events"],
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
      // Not `@all`: this server exposes 44 tools, and their definitions are
      // resent on every request in the turn. Against a 200k tokens-per-minute
      // ceiling that is what pushed investigations into 429s. These are the
      // ones the revert workflow actually uses — names verified against a live
      // `tools/list`.
      enableTools: [
        "list_commits",
        "get_commit",
        "get_file_contents",
        "list_branches",
        "create_branch",
        "create_or_update_file",
        "create_pull_request",
        "list_pull_requests",
        "pull_request_read",
        "update_pull_request",
        "merge_pull_request",
      ],
      // Opening a PR is the *proposal*, and it changes nothing that is running:
      // the pull request is what a human reviews, so producing one must not
      // itself need approval. `@write` covered branch/file/PR creation and so
      // stopped the agent before it could put anything in front of anyone.
      // Merging is the act that reaches production, and a human does that in
      // GitHub — the review is the gate.
      // Named, not `@destructive`: that group already caught a *search* on
      // Notion and a rule *read* on Grafana, so it cannot be trusted not to
      // catch branch and file creation here — the two calls that produce the
      // proposal a human is supposed to review.
      requireApprovalForTools: ["merge_pull_request", "delete_file"],
      // The revert PR is where every incident ends up, so pay the tool-schema
      // cost once up front rather than mid-incident. Names verified against a
      // live `tools/list`; one the server does not expose is silently dropped.
      preloadTools: [
        "list_commits",
        "get_file_contents",
        "create_branch",
        "create_or_update_file",
        "create_pull_request",
      ],
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
      // `@destructive` caught `API-post-search` — Notion's REST naming makes a
      // *search* look like a mutation, and the group classifies on that shape.
      // Every postmortem session stalled on a gate before it could find the
      // database to write to. Writing a postmortem page is this agent's job,
      // not a change to a live system, so only deletion is gated.
      requireApprovalForTools: ["API-delete-a-block"],
      // Same caveat as ArgoCD: these are the names the server actually reports.
      // The `API-` prefix is Notion's own, not a convention of ours.
      preloadTools: ["API-post-search", "API-post-page", "API-patch-page"],
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
 *   SRE_ONCALL_MODEL=google-gemini/gemini-3-6-flash GOOGLE_GEMINI_API_KEY=...
 *
 * Run `npm run provision -- --list-models` to see what this harness offers.
 */
export function primaryModel(): string {
  return env("SRE_ONCALL_MODEL") || "openai/gpt-5-6-luna";
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
      // `ask_user_question` is on by default, and it stopped a postmortem to
      // ask a human to approve its plan — in the harness UI, which nobody is
      // watching at 3am. This agent is woken by an alert, not by a person, and
      // its human checkpoints are deliberate and elsewhere: the Slack approval
      // gate for live changes, the pull request review for anything in git. A
      // question that blocks the loop is not a gate, it is a hang.
      askUserQuestions: { enabled: false },
      // Sub-agents default on too. One starts cold and re-reads every tool
      // schema already paid for, and the binding constraint here is 200k tokens
      // per minute rather than reasoning capacity — investigations have died at
      // 535k and 618k. The prompt already says not to delegate; this enforces it.
      dynamicSubAgents: { enabled: false },
    },
    mcpServers: configured.map((server) => server.attachment),
    skills: skills.map((skill) => ({ name: skill.name })),
  };
}

/**
 * Servers switched off by name, comma-separated, via `MCP_DISABLED`.
 *
 * Every attached server costs memory in its own container and tool-definition
 * tokens in every single request of every turn — and this stack is
 * oversubscribed: the containers share Docker's allocation with the kind node,
 * and have twice starved the Kubernetes API server into `TLS handshake
 * timeout`. Turning off what a given demo does not use is the cheapest lever
 * on both problems.
 */
function disabledServers(): Set<string> {
  return new Set(
    (env("MCP_DISABLED") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

/**
 * An optional MCP server is provisioned only when its credentials are present
 * and it has not been switched off for this run.
 */
export function isConfigured(server: McpDefinition): boolean {
  if (disabledServers().has(server.manifest.name)) return false;
  return (server.requiresEnv ?? []).every((name) => (process.env[name] ?? "") !== "");
}

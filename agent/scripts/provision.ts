/**
 * Provisions the SRE-Oncall agent into a running TrueForge harness:
 * MCP servers → skills → the agent itself. Idempotent — run it as often as you
 * like, including after editing `agent/prompts/base.md`.
 *
 *   node --experimental-strip-types --env-file-if-exists=.env agent/scripts/provision.ts
 */
import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { agentSpec, isConfigured, mcpServers, modelNames, skills } from "../agent.ts";

const baseUrl = process.env["TRUEFORGE_API_URL"] ?? "http://localhost:8790";
const token = process.env["TRUEFORGE_TOKEN"];
const agentName = process.env["TRUEFORGE_AGENT_NAME"] ?? "sre-oncall";

const client = new TrueForge({ baseUrl, ...(token ? { token } : {}) });

function ok(message: string) { console.log(`  ✓ ${message}`); }
function skip(message: string) { console.log(`  – ${message}`); }

/**
 * Registers the Anthropic provider from ANTHROPIC_API_KEY, taking the model
 * definitions (context length, output limits) from the harness's own catalog
 * rather than hardcoding them here — the catalog is what the harness validates
 * a model FQN against.
 */
async function provisionModelProvider(): Promise<void> {
  console.log("Model provider");
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (apiKey === "") {
    skip("anthropic (missing ANTHROPIC_API_KEY) — configure it in the TrueForge UI instead");
    return;
  }

  const catalog = await client.catalogs.modelProviders.list();
  // The catalog holds both well-known providers (which carry model lists) and
  // custom ones (which do not) — narrow to the former before reading `models`.
  const anthropic = catalog.data.find(
    (entry): entry is TrueForgeApi.CatalogWellKnownModelProvider =>
      entry.type === "anthropic" && "models" in entry,
  );
  if (anthropic === undefined) {
    skip("anthropic is not in this harness's catalog");
    return;
  }

  // Only the models this agent actually uses, so the picker stays readable.
  const wanted = new Set(modelNames());
  const models = anthropic.models.filter((model) => wanted.has(`anthropic/${model.name}`));
  if (models.length === 0) {
    throw new Error(
      `None of ${[...wanted].join(", ")} exist in the catalog. Available: ` +
        anthropic.models.map((model) => `anthropic/${model.name}`).join(", "),
    );
  }

  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "anthropic",
      auth: { apiKey },
      models: models as TrueForgeApi.ConfiguredModel[],
    },
  });
  ok(`anthropic (${models.map((model) => model.name).join(", ")})`);
}

async function provisionMcpServers(): Promise<void> {
  console.log("MCP servers");
  for (const server of mcpServers) {
    if (!isConfigured(server)) {
      skip(`${server.manifest.name} (missing ${server.requiresEnv?.join(", ")})`);
      continue;
    }
    await client.settings.mcpServers.createOrUpdate({ manifest: server.manifest });
    ok(`${server.manifest.name} → ${server.manifest.url}`);
  }
}

async function provisionSkills(): Promise<void> {
  console.log("Skills");
  for (const skill of skills) {
    await client.settings.skills.createOrUpdate({ manifest: skill });
    ok(`${skill.name} → ${skill.url}@${skill.ref}`);
  }
}

async function provisionAgent(): Promise<void> {
  console.log("Agent");
  const manifest = agentSpec();
  const existing = await client.agents.list();
  const match = existing.data.find((agent) => agent.name === agentName);

  if (match) {
    await client.agents.update(match.id, { manifest });
    ok(`${agentName} updated (${manifest.mcpServers?.length ?? 0} MCP servers attached)`);
  } else {
    await client.agents.create({ manifest, name: agentName });
    ok(`${agentName} created (${manifest.mcpServers?.length ?? 0} MCP servers attached)`);
  }
}

async function main(): Promise<void> {
  console.log(`Provisioning against ${baseUrl}\n`);
  await provisionModelProvider();
  await provisionMcpServers();
  await provisionSkills();
  await provisionAgent();
  console.log("\nDone. Start an incident with: npm run demo:fault errors");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nProvisioning failed: ${message}`);

  const body = JSON.stringify((err as { body?: unknown }).body ?? "");
  if (body.includes("provider not configured")) {
    console.error(
      "\nThe harness has no model provider for this agent's model.\n" +
        "Set ANTHROPIC_API_KEY in .env and re-run, or add the provider by hand at\n" +
        `${baseUrl}/settings/models.`,
    );
  }
  process.exitCode = 1;
});

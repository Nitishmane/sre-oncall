/**
 * Provisions the SRE-Oncall agent into a running TrueForge harness:
 * MCP servers → skills → the agent itself. Idempotent — run it as often as you
 * like, including after editing `agent/prompts/base.md`.
 *
 *   node --experimental-strip-types --env-file-if-exists=.env agent/scripts/provision.ts
 */
import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  agentSpec, apiKeyEnvFor, isConfigured, mcpServers, modelNames, primaryModel,
  providerOf, skills,
} from "../agent.ts";

const baseUrl = process.env["TRUEFORGE_API_URL"] ?? "http://localhost:8790";
const token = process.env["TRUEFORGE_TOKEN"];
const agentName = process.env["TRUEFORGE_AGENT_NAME"] ?? "sre-oncall";

const client = new TrueForge({ baseUrl, ...(token ? { token } : {}) });

function ok(message: string) { console.log(`  ✓ ${message}`); }
function skip(message: string) { console.log(`  – ${message}`); }

/**
 * Registers the model provider named by SRE_ONCALL_MODEL's `provider/` half,
 * taking model definitions (context length, output limits) from the harness's
 * own catalog rather than hardcoding them — the catalog is what the harness
 * validates a model FQN against.
 *
 * Nothing here is vendor-specific: switching from Anthropic to OpenAI is
 * SRE_ONCALL_MODEL plus the matching API key.
 */
async function provisionModelProvider(): Promise<void> {
  console.log("Model provider");
  const provider = providerOf(primaryModel());
  const keyEnv = apiKeyEnvFor(provider);
  const apiKey = process.env[keyEnv] ?? "";

  if (apiKey === "") {
    skip(`${provider} (missing ${keyEnv}) — or configure it in the TrueForge UI`);
    return;
  }

  const catalog = await client.catalogs.modelProviders.list();
  // The catalog holds both well-known providers (which carry model lists) and
  // custom ones (which do not) — narrow to the former before reading `models`.
  const entry = catalog.data.find(
    (candidate): candidate is TrueForgeApi.CatalogWellKnownModelProvider =>
      candidate.type === provider && "models" in candidate,
  );
  if (entry === undefined) {
    const known = catalog.data.map((candidate) => candidate.type).join(", ");
    throw new Error(`This harness has no "${provider}" provider. It offers: ${known}`);
  }

  // Only the models this agent uses, so the harness's picker stays readable.
  const wanted = new Set(modelNames());
  const models = entry.models.filter((model) => wanted.has(`${provider}/${model.name}`));
  if (models.length === 0) {
    throw new Error(
      `None of ${[...wanted].join(", ")} exist in the catalog. Available: ` +
        entry.models.map((model) => `${provider}/${model.name}`).join(", "),
    );
  }

  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: provider,
      auth: { apiKey },
      models: models as TrueForgeApi.ConfiguredModel[],
    } as TrueForgeApi.ModelProviderManifest,
  });
  ok(`${provider} (${models.map((model) => model.name).join(", ")})`);
}

/** `--list-models` — what this harness can be pointed at. */
async function listModels(): Promise<void> {
  const catalog = await client.catalogs.modelProviders.list();
  console.log("Models available on this harness (set one as SRE_ONCALL_MODEL):\n");
  for (const entry of catalog.data) {
    if (!("models" in entry) || entry.models.length === 0) continue;
    const keyEnv = apiKeyEnvFor(entry.type);
    console.log(`  ${entry.type}  (needs ${keyEnv})`);
    for (const model of entry.models) console.log(`    ${entry.type}/${model.name}`);
    console.log("");
  }
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
  if (process.argv.includes("--list-models")) {
    await listModels();
    return;
  }
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
        `Set ${apiKeyEnvFor(providerOf(primaryModel()))} in .env and re-run, or add the ` +
        `provider by hand at ${baseUrl}/settings/models.\n` +
        "See what this harness offers with: npm run provision -- --list-models",
    );
  }
  process.exitCode = 1;
});

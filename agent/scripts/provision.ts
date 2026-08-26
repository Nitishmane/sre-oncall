/**
 * Provisions the SRE-Oncall agent into a running TrueForge harness:
 * MCP servers → skills → the agent itself. Idempotent — run it as often as you
 * like, including after editing `agent/prompts/base.md`.
 *
 *   node --experimental-strip-types --env-file-if-exists=.env agent/scripts/provision.ts
 */
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { agentSpec, isConfigured, mcpServers, skills } from "../agent.ts";

const baseUrl = process.env["TRUEFORGE_API_URL"] ?? "http://127.0.0.1:8790";
const token = process.env["TRUEFORGE_TOKEN"];
const agentName = process.env["TRUEFORGE_AGENT_NAME"] ?? "sre-oncall";

const client = new TrueForge({ baseUrl, ...(token ? { token } : {}) });

function ok(message: string) { console.log(`  ✓ ${message}`); }
function skip(message: string) { console.log(`  – ${message}`); }

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
  await provisionMcpServers();
  await provisionSkills();
  await provisionAgent();
  console.log("\nDone. Start an incident with: npm run demo:fault --workspace demo-env");
}

main().catch((err: unknown) => {
  console.error(`\nProvisioning failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

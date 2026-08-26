import { TrueForge } from "@truefoundry/trueforge-sdk";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

/**
 * Thin wrapper over the TrueForge SDK: create a session bound to the saved
 * `sre-oncall` agent, then start one turn.
 *
 * `createTurn` (as opposed to `createTurnStream`) returns as soon as the turn is
 * running, so the harness keeps executing in the background — including pausing
 * at approval gates. Progress is observed through the session event stream by
 * the Slack bot and the chatbox, never by blocking the webhook handler.
 */
export function createHarness(config: Config, log: Logger) {
  const client = new TrueForge({
    baseUrl: config.TRUEFORGE_API_URL,
    ...(config.TRUEFORGE_TOKEN ? { token: config.TRUEFORGE_TOKEN } : {}),
  });

  async function startSession(prompt: string, context: Record<string, unknown>): Promise<string> {
    const session = await client.sessions.create({
      agent: { name: config.TRUEFORGE_AGENT_NAME },
    });
    const sessionId = session.data.id;
    log.info("session created", { ...context, sessionId });

    const turn = await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.message", content: prompt }],
    });
    log.info("turn started", { ...context, sessionId, turnId: turn.data.id });
    return sessionId;
  }

  /** Resumes a session paused at an approval gate (Slack Approve/Reject button). */
  async function submitApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    decision: { status: "allow" } | { status: "deny"; reason?: string },
  ): Promise<void> {
    await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.tool_approval", threadId, toolCallId, approval: decision }],
    });
    log.info("approval submitted", { sessionId, toolCallId, decision: decision.status });
  }

  async function health(): Promise<boolean> {
    try {
      await client.agents.list();
      return true;
    } catch {
      return false;
    }
  }

  return { client, startSession, submitApproval, health };
}

export type Harness = ReturnType<typeof createHarness>;

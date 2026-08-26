import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

/**
 * Thin wrapper over the TrueForge SDK.
 *
 * Turns are created non-streaming (`createTurn`), which returns as soon as the
 * turn is running and lets the harness keep executing in the background —
 * including pausing at approval gates. Surfaces that want to render progress
 * subscribe to the turn separately, so a slow Slack client can never hold up an
 * incident.
 *
 * Note that resuming an approval creates a *new turn*: a surface following a
 * session has to follow each turn in succession, not just the first.
 */
export interface StartedTurn {
  sessionId: string;
  turnId: string;
}

export function createHarness(config: Config, log: Logger) {
  const client = new TrueForge({
    baseUrl: config.TRUEFORGE_API_URL,
    ...(config.TRUEFORGE_TOKEN ? { token: config.TRUEFORGE_TOKEN } : {}),
  });

  async function startSession(prompt: string, context: Record<string, unknown>): Promise<StartedTurn> {
    const session = await client.sessions.create({
      agent: { name: config.TRUEFORGE_AGENT_NAME },
    });
    const sessionId = session.data.id;
    log.info("session created", { ...context, sessionId });

    const turn = await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.message", content: prompt }],
    });
    log.info("turn started", { ...context, sessionId, turnId: turn.data.id });
    return { sessionId, turnId: turn.data.id };
  }

  /** Adds a follow-up message to an existing session. */
  async function continueSession(sessionId: string, prompt: string): Promise<StartedTurn> {
    const turn = await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.message", content: prompt }],
    });
    log.info("turn started", { kind: "follow-up", sessionId, turnId: turn.data.id });
    return { sessionId, turnId: turn.data.id };
  }

  /** Resumes a session paused at an approval gate. */
  async function submitApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    decision: { status: "allow" } | { status: "deny"; reason?: string },
  ): Promise<StartedTurn> {
    const turn = await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.tool_approval", threadId, toolCallId, approval: decision }],
    });
    log.info("approval submitted", { sessionId, toolCallId, decision: decision.status });
    return { sessionId, turnId: turn.data.id };
  }

  /** Live event stream for one turn, for surfaces that render progress. */
  async function subscribeTurn(
    sessionId: string,
    turnId: string,
  ): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>> {
    return client.sessions.subscribeToTurn(sessionId, turnId);
  }

  async function health(): Promise<boolean> {
    try {
      await client.agents.list();
      return true;
    } catch {
      return false;
    }
  }

  return { client, startSession, continueSession, submitApproval, subscribeTurn, health };
}

export type Harness = ReturnType<typeof createHarness>;

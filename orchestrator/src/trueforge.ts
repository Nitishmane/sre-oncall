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

  /**
   * `agentName` defaults to the configured on-call agent, so the alert pipeline
   * is unchanged. A Slack bot bound to a different agent passes its own.
   */
  async function startSession(
    prompt: string,
    context: Record<string, unknown>,
    agentName: string = config.TRUEFORGE_AGENT_NAME,
  ): Promise<StartedTurn> {
    const session = await client.sessions.create({
      agent: { name: agentName },
    });
    const sessionId = session.data.id;
    log.info("session created", { ...context, sessionId, agent: agentName });

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

  /**
   * Answers an `ask_user_question` the agent stopped on.
   *
   * That question is a client-side *tool call*, not a special kind of event, so
   * this is the exact parallel of `submitApproval` — same thread and tool-call
   * ids, free text instead of a decision. Sending the answer as an ordinary
   * `user.message` instead would leave the tool call outstanding forever.
   */
  async function submitQuestionAnswer(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    content: string,
  ): Promise<StartedTurn> {
    const turn = await client.sessions.createTurn(sessionId, {
      input: [{ type: "user.tool_response", threadId, toolCallId, content }],
    });
    log.info("question answered", { sessionId, toolCallId });
    return { sessionId, turnId: turn.data.id };
  }

  /**
   * Recovers the `model.message` that requested a tool call.
   *
   * `subscribeToTurn` does not replay: a follower that attaches after the model
   * has already asked for a tool never sees the call, and an approval prompt
   * would otherwise say "unknown tool" with no arguments. The approval event
   * carries the id of the message that asked, so we can fetch it back.
   */
  async function findToolCall(
    sessionId: string,
    eventId: string,
    toolCallId: string,
  ): Promise<{ call: TrueForgeApi.ToolCall; rationale: string } | null> {
    try {
      const page = await client.sessions.listEvents(sessionId);
      for await (const item of page) {
        // The list wraps each event; older harness builds returned it bare.
        const event = ((item as { event?: unknown }).event ?? item) as TrueForgeApi.SessionEvent;
        if (event.type !== "model.message" || event.id !== eventId) continue;
        const call = (event.toolCalls ?? []).find((candidate) => candidate.id === toolCallId);
        if (call === undefined) return null;
        const content = event.content;
        const rationale =
          typeof content === "string"
            ? content
            : (content ?? [])
                .filter((part): part is TrueForgeApi.ChatCompletionContentPartText =>
                  part.type === "text")
                .map((part) => part.text)
                .join("");
        return { call, rationale };
      }
    } catch (err) {
      log.warn("could not recover the tool call behind an approval", {
        sessionId,
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
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

  return {
    client, startSession, continueSession, submitApproval, submitQuestionAnswer,
    subscribeTurn, findToolCall, health,
  };
}

export type Harness = ReturnType<typeof createHarness>;

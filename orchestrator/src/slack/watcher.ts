import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { Logger } from "../logger.ts";
import type { Store } from "../store.ts";
import {
  createTranslator,
  UNKNOWN_TOOL,
  type PendingApproval,
  type PendingQuestion,
} from "./translator.ts";
import { applyAction, type Surface } from "./surface.ts";

/**
 * Follows a session across all of its turns and renders it onto a surface.
 *
 * A session is not one stream: the initial question is one turn, and every
 * approval resume starts another. The follower keeps a single translator across
 * all of them (so an approval request can still name the tool call it came
 * from) and pumps each turn's stream in order.
 *
 * Deliberately failure-tolerant: an incident must not break because Slack was
 * slow or a stream dropped.
 */
export interface FollowerDeps {
  log: Logger;
  store: Store;
  now?: () => number;
  /**
   * Recovers a tool call the turn stream never delivered. Optional so tests and
   * non-Slack surfaces can build a follower without a harness.
   */
  resolveToolCall?: (
    sessionId: string,
    eventId: string,
    toolCallId: string,
  ) => Promise<{ toolLabel: string; arguments: string; rationale: string } | null>;
}

export type TurnStream = AsyncIterable<TrueForgeApi.TurnStreamingEvent>;

export function createFollower(
  sessionId: string,
  surface: Surface,
  deps: FollowerDeps,
) {
  const now = deps.now ?? Date.now;
  const translate = createTranslator(sessionId);
  /** Turns are pumped one after another, never concurrently. */
  let chain: Promise<void> = Promise.resolve();

  const onError = (err: unknown, action: { kind: string }) => {
    deps.log.warn("surface call failed", {
      sessionId,
      action: action.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  /**
   * Records a question before posting it, for the same reason approvals are
   * recorded first: the thread must be able to find the pending call again when
   * someone replies, even if the Slack post failed or the process restarted.
   */
  async function recordAndAsk(question: PendingQuestion): Promise<void> {
    const binding = deps.store.slackSession(sessionId);
    if (binding === undefined) {
      // No Slack thread to answer in — render it anyway so it is not lost.
      await applyAction(surface, { kind: "question", question }, onError);
      return;
    }
    deps.store.recordQuestion({
      sessionId,
      threadId: question.threadId,
      toolCallId: question.toolCallId,
      question: question.question,
      channel: binding.channel,
      threadTs: binding.thread_ts,
    }, now());
    deps.log.info("question asked", { sessionId, toolCallId: question.toolCallId });
    await applyAction(surface, { kind: "question", question }, onError);
  }

  async function recordAndShow(pending: PendingApproval): Promise<void> {
    const approval = await withToolDetail(pending);
    // Written to the audit log before it is shown, so the gate is recorded even
    // if the Slack post fails.
    const base = {
      sessionId,
      threadId: approval.threadId,
      toolCallId: approval.toolCallId,
      toolLabel: approval.toolLabel,
      arguments: approval.arguments,
      rationale: approval.rationale,
    };
    deps.store.recordApprovalRequest({ ...base, channel: null, messageTs: null }, now());
    deps.log.info("approval requested", {
      sessionId,
      tool: approval.toolLabel,
      toolCallId: approval.toolCallId,
    });

    try {
      const messageTs = await surface.postApproval(approval);
      if (messageTs !== null) {
        const binding = deps.store.slackSession(sessionId);
        deps.store.recordApprovalRequest(
          { ...base, channel: binding?.channel ?? null, messageTs },
          now(),
        );
      }
    } catch (err) {
      onError(err, { kind: "approval" });
    }
  }

  /**
   * Fills in a tool call the stream dropped. Nobody can meaningfully approve
   * "unknown tool", so it is worth one extra request to say what is actually
   * being asked for.
   */
  async function withToolDetail(approval: PendingApproval): Promise<PendingApproval> {
    if (approval.toolLabel !== UNKNOWN_TOOL) return approval;
    if (approval.sourceEventId === null || deps.resolveToolCall === undefined) return approval;

    const found = await deps.resolveToolCall(
      sessionId,
      approval.sourceEventId,
      approval.toolCallId,
    );
    if (found === null) return approval;
    return {
      ...approval,
      toolLabel: found.toolLabel,
      arguments: found.arguments,
      rationale: approval.rationale.trim() || found.rationale,
    };
  }

  async function pump(stream: TurnStream): Promise<void> {
    for await (const event of stream) {
      for (const action of translate.handle(event)) {
        if (action.kind === "approval") {
          await recordAndShow(action.approval);
          continue;
        }
        if (action.kind === "question") {
          await recordAndAsk(action.question);
          continue;
        }
        await applyAction(surface, action, onError);
      }
    }
  }

  /** Queues a turn's stream behind whatever is already being rendered. */
  function follow(stream: Promise<TurnStream>): Promise<void> {
    chain = chain
      .then(async () => {
        await pump(await stream);
      })
      .catch(async (err: unknown) => {
        deps.log.error("turn stream ended unexpectedly", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        await applyAction(
          surface,
          { kind: "done", ok: false, detail: "Lost the connection to the harness." },
          onError,
        );
      });
    return chain;
  }

  return { follow, idle: () => chain };
}

export type Follower = ReturnType<typeof createFollower>;

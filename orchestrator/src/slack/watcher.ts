import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { Logger } from "../logger.ts";
import type { Store } from "../store.ts";
import { createTranslator } from "./translator.ts";
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

  async function recordAndShow(approval: {
    threadId: string; toolCallId: string; toolLabel: string; arguments: string; sessionId: string;
  }): Promise<void> {
    // Written to the audit log before it is shown, so the gate is recorded even
    // if the Slack post fails.
    const base = {
      sessionId,
      threadId: approval.threadId,
      toolCallId: approval.toolCallId,
      toolLabel: approval.toolLabel,
      arguments: approval.arguments,
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

  async function pump(stream: TurnStream): Promise<void> {
    for await (const event of stream) {
      for (const action of translate.handle(event)) {
        if (action.kind === "approval") {
          await recordAndShow(action.approval);
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

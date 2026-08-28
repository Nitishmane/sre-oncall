import bolt from "@slack/bolt";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { Store } from "../store.ts";
import type { Harness } from "../trueforge.ts";
import { createKeyedQueue } from "../concurrency.ts";
import { createFollower, type Follower } from "./watcher.ts";
import { createSlackSurface } from "./slack-surface.ts";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  decidedBlocks,
  decodeRef,
  incidentBlocks,
  resolvedIncidentBlocks,
} from "./blocks.ts";
import { formatArguments, toolLabel, type PendingApproval } from "./translator.ts";

const { App, LogLevel } = bolt;

/**
 * The Slack surface: mentions and DMs start (or resume) a session, incident
 * sessions announce themselves in the incident channel, and approval gates are
 * decided with Block Kit buttons.
 *
 * Socket Mode, so no public URL is needed — Slack holds the WebSocket open.
 */
export interface SlackDeps {
  config: Config;
  log: Logger;
  store: Store;
  harness: Harness;
}

export function createSlackApp({ config, log, store, harness }: SlackDeps) {
  if (config.SLACK_BOT_TOKEN === undefined || config.SLACK_APP_TOKEN === undefined) {
    throw new Error("createSlackApp requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN");
  }

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: config.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.WARN,
  });

  // One conversation at a time per Slack thread, so rapid follow-up replies are
  // answered in order rather than racing each other through the harness.
  const threads = createKeyedQueue();
  /** Live followers, so an approval resume can be rendered into the same thread. */
  const followers = new Map<string, Follower>();
  const approvers = new Set(config.SLACK_APPROVER_IDS);
  const restricted = approvers.size > 0;

  function mayApprove(userId: string): boolean {
    return !restricted || approvers.has(userId);
  }

  /**
   * Binds a session to a Slack thread and returns the follower that renders it.
   * Re-binding an already-followed session reuses its follower, so the
   * translator's memory of earlier tool calls survives across turns.
   */
  function attach(sessionId: string, channel: string, threadTs: string): Follower {
    store.bindSlackThread(sessionId, channel, threadTs, null, Date.now());
    const existing = followers.get(sessionId);
    if (existing) return existing;

    const surface = createSlackSurface({ app, store, channel, threadTs, sessionId, restricted });
    const follower = createFollower(sessionId, surface, {
      log,
      store,
      // The turn stream does not replay, so a follower that attached late never
      // saw the tool call behind an approval. Fetch it back rather than ask
      // someone to approve "unknown tool".
      resolveToolCall: async (session, eventId, toolCallId) => {
        const found = await harness.findToolCall(session, eventId, toolCallId);
        if (found === null) return null;
        return {
          toolLabel: toolLabel(found.call),
          arguments: formatArguments(found.call.function.arguments),
          rationale: found.rationale,
        };
      },
    });
    followers.set(sessionId, follower);
    return follower;
  }

  /** Announces an orchestrator-started session in the incident channel. */
  async function announceIncident(params: {
    sessionId: string;
    turnId: string;
    ruleName: string;
    fingerprint: string;
    kind: "healing" | "postmortem" | "handoff";
  }): Promise<void> {
    const channel = config.SLACK_INCIDENT_CHANNEL;
    if (channel === undefined) return;
    try {
      // One incident, one thread. An alert produces several sessions over its
      // life — the healing run, a postmortem when it resolves, a re-triage if
      // it fires again after the cooldown — and announcing each at the top
      // level scattered a single outage across the channel and re-raised an
      // alert that was already raised. The first session for a fingerprint
      // opens the thread; the rest report inside it.
      const existing = store.incidentThread(params.fingerprint);

      if (existing !== undefined) {
        const follower = attach(params.sessionId, existing.channel, existing.thread_ts);
        // A short line in the thread, not a new alert: the incident is already
        // on the channel and the reader is already looking at it.
        await app.client.chat.postMessage({
          channel: existing.channel,
          thread_ts: existing.thread_ts,
          text: `${followUpLabel(params.kind)}…`,
        });
        follower.follow(harness.subscribeTurn(params.sessionId, params.turnId));
        return;
      }

      const posted = await app.client.chat.postMessage({
        channel,
        text: `${params.ruleName}: ${params.kind} session started`,
        blocks: incidentBlocks(params),
      });
      if (typeof posted.ts === "string") {
        // Claim returns whichever thread is in force, so if a second session
        // for the same fingerprint raced us here, both render into one thread.
        const thread = store.claimIncidentThread(
          params.fingerprint, channel, posted.ts, Date.now(),
        );
        const follower = attach(params.sessionId, thread.channel, thread.thread_ts);
        follower.follow(harness.subscribeTurn(params.sessionId, params.turnId));
      }
    } catch (err) {
      log.error("failed to announce incident in Slack", {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Repaints the incident's original message as resolved. Best effort: if it
   * fails, the thread still carries the truth, so an incident is never held up
   * over a cosmetic update.
   */
  async function markIncidentResolved(params: {
    fingerprint: string;
    ruleName: string;
    resolvedAt: Date;
  }): Promise<void> {
    const thread = store.incidentThread(params.fingerprint);
    if (thread === undefined) return;
    try {
      await app.client.chat.update({
        channel: thread.channel,
        ts: thread.thread_ts,
        text: `${params.ruleName}: resolved`,
        blocks: resolvedIncidentBlocks(params),
      });
    } catch (err) {
      log.warn("could not repaint the incident message as resolved", {
        fingerprint: params.fingerprint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** What a later session for an already-announced incident says as it starts. */
  function followUpLabel(kind: "healing" | "postmortem" | "handoff"): string {
    if (kind === "postmortem") return "Resolved — writing the postmortem";
    if (kind === "handoff") return "Preparing the on-call handoff";
    return "Picking this up again";
  }

  /** Strips the bot mention so the agent doesn't see `<@U0XXXXXXXXX>` in the question. */
  function cleanText(text: string): string {
    return text.replace(/<@[A-Z0-9]+>/g, "").trim();
  }

  async function handleQuestion(channel: string, threadTs: string, text: string): Promise<void> {
    const question = cleanText(text);
    if (question === "") return;

    await threads.enqueue(`${channel}:${threadTs}`, async () => {
      const existing = store.slackSessionForThread(channel, threadTs);
      if (existing) {
        // Follow-up in a thread we already own: resume that session.
        const follower = attach(existing.session_id, channel, threadTs);
        const turn = await harness.continueSession(existing.session_id, question);
        follower.follow(harness.subscribeTurn(turn.sessionId, turn.turnId));
        return;
      }
      const started = await harness.startSession(question, { kind: "chat", channel });
      const follower = attach(started.sessionId, channel, threadTs);
      follower.follow(harness.subscribeTurn(started.sessionId, started.turnId));
    });
  }

  app.event("app_mention", async ({ event }) => {
    const threadTs = event.thread_ts ?? event.ts;
    await handleQuestion(event.channel, threadTs, event.text ?? "");
  });

  app.message(async ({ message }) => {
    // Direct messages only; channel messages need an explicit mention.
    if (message.subtype !== undefined || message.channel_type !== "im") return;
    const text = "text" in message ? (message.text ?? "") : "";
    const threadTs = "thread_ts" in message && message.thread_ts ? message.thread_ts : message.ts;
    await handleQuestion(message.channel, threadTs, text);
  });

  async function decide(
    decision: "approved" | "denied",
    payload: { value?: string; userId: string; channel: string; messageTs: string },
    respond: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const ref = decodeRef(payload.value);
    if (ref === null) {
      await respond("That approval button is malformed — I can't act on it.");
      return;
    }

    if (!mayApprove(payload.userId)) {
      log.warn("approval attempt from a non-approver", { user: payload.userId, ...ref });
      await respond("You are not on the approver list for this deployment.");
      return;
    }

    const record = store.approval(ref.sessionId, ref.toolCallId);
    // Claim the decision first: two people clicking at once must not both submit.
    const claimed = store.recordApprovalDecision(
      ref.sessionId, ref.toolCallId, decision, payload.userId, Date.now(),
    );
    if (!claimed) {
      await respond(
        record?.decision != null
          ? `Already ${record.decision} by <@${record.decided_by ?? "someone"}>.`
          : "That approval is no longer pending.",
      );
      return;
    }

    try {
      const resumed = await harness.submitApproval(
        ref.sessionId,
        ref.threadId,
        ref.toolCallId,
        decision === "approved" ? { status: "allow" } : { status: "deny", reason: `Denied by ${payload.userId}` },
      );
      // The resume is a new turn: keep rendering it into the same thread.
      followers.get(ref.sessionId)?.follow(harness.subscribeTurn(resumed.sessionId, resumed.turnId));
    } catch (err) {
      log.error("failed to submit approval to the harness", {
        ...ref,
        error: err instanceof Error ? err.message : String(err),
      });
      await respond("I recorded your decision but the harness rejected it — check the orchestrator logs.");
      return;
    }

    const approval: PendingApproval = {
      sessionId: ref.sessionId,
      threadId: ref.threadId,
      toolCallId: ref.toolCallId,
      toolLabel: record?.tool_label ?? "the requested tool",
      arguments: record?.arguments ?? "",
      rationale: record?.rationale ?? "",
      sourceEventId: null,
    };
    await app.client.chat.update({
      channel: payload.channel,
      ts: payload.messageTs,
      text: `${approval.toolLabel} ${decision}`,
      blocks: decidedBlocks(approval, decision, payload.userId),
    });
  }

  app.action(APPROVE_ACTION_ID, async ({ ack, body, action, respond }) => {
    await ack();
    await decide("approved", extract(body, action), async (text) => respond({ text, response_type: "ephemeral" }));
  });

  app.action(DENY_ACTION_ID, async ({ ack, body, action, respond }) => {
    await ack();
    await decide("denied", extract(body, action), async (text) => respond({ text, response_type: "ephemeral" }));
  });

  async function start(): Promise<void> {
    await app.start();
    log.info("slack app connected", {
      incidentChannel: config.SLACK_INCIDENT_CHANNEL ?? "(none)",
      approvers: restricted ? approvers.size : "unrestricted",
    });
    if (!restricted) {
      log.warn("SLACK_APPROVER_IDS is unset — any workspace member can approve remediation");
    }
  }

  return { app, start, announceIncident, markIncidentResolved, stop: () => app.stop() };
}

/** Narrows Bolt's loosely typed action payloads to the four fields we use. */
function extract(body: unknown, action: unknown): {
  value?: string; userId: string; channel: string; messageTs: string;
} {
  const b = body as {
    user?: { id?: string };
    channel?: { id?: string };
    message?: { ts?: string };
  };
  const a = action as { value?: string };
  return {
    value: a.value,
    userId: b.user?.id ?? "unknown",
    channel: b.channel?.id ?? "",
    messageTs: b.message?.ts ?? "",
  };
}

export type SlackApp = ReturnType<typeof createSlackApp>;

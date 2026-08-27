import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { openStore } from "../src/store.ts";
import { createLogger } from "../src/logger.ts";
import { createFollower } from "../src/slack/watcher.ts";
import { decodeRef, encodeRef } from "../src/slack/blocks.ts";
import type { Surface } from "../src/slack/surface.ts";
import type { PendingApproval } from "../src/slack/translator.ts";

const silent = createLogger("error");

function recordingSurface() {
  const calls: string[] = [];
  const approvals: PendingApproval[] = [];
  const surface: Surface = {
    setStatus: async (text) => { calls.push(`status:${text}`); },
    post: async (text) => { calls.push(`post:${text}`); },
    postApproval: async (approval) => {
      approvals.push(approval);
      calls.push(`approval:${approval.toolLabel}`);
      return "1735000000.000100";
    },
    finish: async (ok) => { calls.push(`finish:${ok}`); },
  };
  return { surface, calls, approvals };
}

async function* streamOf(...events: TrueForgeApi.TurnStreamingEvent[]) {
  for (const event of events) yield event;
}

const approvalTurn: TrueForgeApi.TurnStreamingEvent[] = [
  {
    type: "model.message",
    id: "evt-1",
    createdAt: "2026-08-25T10:00:00Z",
    threadId: "main",
    content: "Rolling back the bad sync.",
    toolCalls: [{
      id: "call-1",
      type: "function",
      function: { name: "rollback_application", arguments: '{"app":"demo-service"}' },
      toolInfo: { type: "mcp", name: "rollback_application", serverName: "argocd", serverId: "s1" },
    }],
  },
  {
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:00:05Z",
    threadId: "main",
    toolCalls: [{ id: "call-1", sourceEventId: "evt-1" }],
  },
];

test("an approval request is written to the audit log before it is shown", async () => {
  const store = openStore(":memory:");
  const { surface } = recordingSurface();
  const follower = createFollower("sess-1", surface, { log: silent, store, now: () => 1_000_000 });

  await follower.follow(Promise.resolve(streamOf(...approvalTurn)));

  const row = store.approval("sess-1", "call-1");
  assert.equal(row?.tool_label, "argocd.rollback_application");
  assert.equal(row?.thread_id, "main");
  assert.equal(row?.requested_at, 1_000_000);
  assert.equal(row?.decision, null, "recorded as pending");
  store.close();
});

test("the audit log survives a surface that cannot post", async () => {
  const store = openStore(":memory:");
  const broken: Surface = {
    setStatus: async () => {},
    post: async () => {},
    postApproval: async () => { throw new Error("slack is down"); },
    finish: async () => {},
  };
  const follower = createFollower("sess-1", broken, { log: silent, store, now: () => 1_000_000 });

  await follower.follow(Promise.resolve(streamOf(...approvalTurn)));

  assert.equal(store.approval("sess-1", "call-1")?.tool_label, "argocd.rollback_application");
  store.close();
});

test("the message ts is recorded so the prompt can be updated after a decision", async () => {
  const store = openStore(":memory:");
  const { surface } = recordingSurface();
  store.bindSlackThread("sess-1", "C123", "1735000000.000001", null, 1_000_000);
  const follower = createFollower("sess-1", surface, { log: silent, store, now: () => 1_000_000 });

  await follower.follow(Promise.resolve(streamOf(...approvalTurn)));

  const row = store.approval("sess-1", "call-1");
  assert.equal(row?.message_ts, "1735000000.000100");
  assert.equal(row?.channel, "C123");
  store.close();
});

test("a decision can only be claimed once", () => {
  const store = openStore(":memory:");
  store.recordApprovalRequest({
    sessionId: "sess-1", threadId: "main", toolCallId: "call-1",
    toolLabel: "argocd.rollback_application", arguments: "{}",
    channel: "C1", messageTs: "1.1",
  }, 1_000_000);

  const first = store.recordApprovalDecision("sess-1", "call-1", "approved", "U_ALICE", 1_000_100);
  const second = store.recordApprovalDecision("sess-1", "call-1", "denied", "U_BOB", 1_000_200);

  assert.equal(first, true);
  assert.equal(second, false, "a second click must not re-decide");
  const row = store.approval("sess-1", "call-1");
  assert.equal(row?.decision, "approved");
  assert.equal(row?.decided_by, "U_ALICE");
  store.close();
});

test("re-requesting the same approval does not duplicate the audit row", () => {
  const store = openStore(":memory:");
  const request = {
    sessionId: "sess-1", threadId: "main", toolCallId: "call-1",
    toolLabel: "argocd.rollback_application", arguments: "{}",
    channel: null, messageTs: null,
  };
  store.recordApprovalRequest(request, 1_000_000);
  store.recordApprovalRequest({ ...request, channel: "C1", messageTs: "1.1" }, 1_000_050);

  const rows = store.approvalsSince(0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.channel, "C1");
  assert.equal(rows[0]?.requested_at, 1_000_000, "the original request time is kept");
  store.close();
});

test("turns are rendered one after another, never interleaved", async () => {
  const store = openStore(":memory:");
  const { surface, calls } = recordingSurface();
  const follower = createFollower("sess-1", surface, { log: silent, store, now: () => 1_000_000 });

  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => { releaseFirst = resolve; });

  async function* slowTurn(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
    yield { type: "model.message", id: "a", createdAt: "t", threadId: "main", content: "first" };
    await held;
    yield { type: "model.message", id: "b", createdAt: "t", threadId: "main", content: "first-end" };
  }

  const one = follower.follow(Promise.resolve(slowTurn()));
  const two = follower.follow(Promise.resolve(streamOf(
    { type: "model.message", id: "c", createdAt: "t", threadId: "main", content: "second" },
  )));

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ["status:first"], "the second turn waits");

  releaseFirst();
  await Promise.all([one, two]);
  assert.deepEqual(calls, ["status:first", "status:first-end", "status:second"]);
  store.close();
});

test("a dropped stream tells the thread rather than failing silently", async () => {
  const store = openStore(":memory:");
  const { surface, calls } = recordingSurface();
  const follower = createFollower("sess-1", surface, { log: silent, store, now: () => 1_000_000 });

  async function* broken(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
    yield { type: "model.message", id: "a", createdAt: "t", threadId: "main", content: "working" };
    throw new Error("connection reset");
  }

  await follower.follow(Promise.resolve(broken()));
  assert.deepEqual(calls, ["status:working", "finish:false"]);
  store.close();
});

test("button payloads round-trip, and malformed ones are rejected", () => {
  const ref = { sessionId: "sess-1", threadId: "main", toolCallId: "call-1" };
  assert.deepEqual(decodeRef(encodeRef(ref)), ref);

  assert.equal(decodeRef(undefined), null);
  assert.equal(decodeRef("not json"), null);
  assert.equal(decodeRef('{"sessionId":"s"}'), null, "a partial ref is refused");
  assert.equal(decodeRef('{"sessionId":1,"threadId":"m","toolCallId":"c"}'), null, "types are checked");
  assert.equal(decodeRef('"a string"'), null);
});

test("a tool call the stream never delivered is fetched back, not shown as unknown", async () => {
  // Reproduces the real failure: `subscribeToTurn` does not replay, so a
  // follower that attaches after the model has already asked for a tool sees
  // only the approval event. Nobody can meaningfully approve "unknown tool".
  const store = openStore(":memory:");
  const { surface, approvals } = recordingSurface();
  let asked: { eventId: string; toolCallId: string } | null = null;

  const follower = createFollower("sess-late", surface, {
    log: silent,
    store,
    resolveToolCall: async (_session, eventId, toolCallId) => {
      asked = { eventId, toolCallId };
      return {
        toolLabel: "argocd.rollback_application",
        arguments: '{"app":"demo-service"}',
        rationale: "Sync 47 raised 5xx to 18%; rolling back to 46.",
      };
    },
  });

  await follower.follow(
    Promise.resolve(
      streamOf({
        type: "tool.approval_required",
        id: "evt-2",
        createdAt: "2026-08-25T10:00:01Z",
        threadId: "main",
        toolCalls: [{ id: "call-1", sourceEventId: "evt-1" }],
      }),
    ),
  );

  assert.deepEqual(asked, { eventId: "evt-1", toolCallId: "call-1" });
  assert.equal(approvals[0]?.toolLabel, "argocd.rollback_application");
  assert.match(approvals[0]?.rationale ?? "", /rolling back to 46/i);

  // And the recovered detail is what lands in the audit log.
  const row = store.approval("sess-late", "call-1");
  assert.equal(row?.tool_label, "argocd.rollback_application");
  assert.match(row?.rationale ?? "", /18%/);
});

test("a resolver that cannot find the call leaves the gate intact", async () => {
  const store = openStore(":memory:");
  const { surface, approvals } = recordingSurface();
  const follower = createFollower("sess-miss", surface, {
    log: silent,
    store,
    resolveToolCall: async () => null,
  });

  await follower.follow(
    Promise.resolve(
      streamOf({
        type: "tool.approval_required",
        id: "evt-2",
        createdAt: "2026-08-25T10:00:01Z",
        threadId: "main",
        toolCalls: [{ id: "call-9", sourceEventId: "evt-1" }],
      }),
    ),
  );

  // Still prompted — failing to describe an action must never mean skipping
  // the approval for it.
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolLabel, "unknown tool");
  assert.equal(store.approval("sess-miss", "call-9")?.decision, null);
});

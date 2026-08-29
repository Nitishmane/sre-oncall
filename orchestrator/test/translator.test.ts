import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { createTranslator } from "../src/slack/translator.ts";
import { chunkText } from "../src/slack/slack-surface.ts";

function modelMessage(overrides: Partial<TrueForgeApi.ModelMessageEvent> = {}): TrueForgeApi.ModelMessageEvent {
  return {
    type: "model.message",
    id: "evt-1",
    createdAt: "2026-08-25T10:00:00Z",
    threadId: "main",
    content: null,
    ...overrides,
  };
}

function toolCall(id: string, server: string, name: string, args: string): TrueForgeApi.ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
    toolInfo: { type: "mcp", name, serverName: server, serverId: "srv-1" },
  };
}

function donePausedOnQuestion(): TrueForgeApi.TurnStreamingEvent {
  return {
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:02:00Z",
    threadId: "main",
    state: {
      status: "done",
      output: null,
      requiredActions: [{
        type: "tool.response_required",
        id: "ra-1",
        createdAt: "2026-08-25T10:02:00Z",
        threadId: "main",
        toolCalls: [{ id: "call-q", sourceEventId: "evt-1" }],
      }],
      completedAt: "2026-08-25T10:02:00Z",
    },
  } as TrueForgeApi.TurnStreamingEvent;
}

test("assistant text becomes a status line", () => {
  const t = createTranslator("sess-1");
  const actions = t.handle(modelMessage({ content: "Checking the error rate first.\nThen the pods." }));
  assert.deepEqual(actions, [{ kind: "status", text: "Checking the error rate first." }]);
});

test("a tool call reports the tool by server and name", () => {
  const t = createTranslator("sess-1");
  const actions = t.handle(modelMessage({
    toolCalls: [toolCall("call-1", "grafana", "query_prometheus", "{}")],
  }));
  assert.deepEqual(actions, [{ kind: "status", text: "Running `grafana.query_prometheus`…" }]);
});

test("an approval request names the tool and shows its arguments", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [toolCall("call-9", "argocd", "rollback_application", '{"app":"demo-service","revision":"abc1234"}')],
  }));

  const actions = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-9", sourceEventId: "evt-1" }],
  });

  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action?.kind, "approval");
  if (action?.kind !== "approval") return;
  assert.equal(action.approval.toolLabel, "argocd.rollback_application");
  assert.equal(action.approval.toolCallId, "call-9");
  assert.equal(action.approval.sessionId, "sess-1");
  assert.match(action.approval.arguments, /"revision": "abc1234"/, "arguments are pretty-printed");
});

test("an approval for a tool call we never saw still renders", () => {
  const t = createTranslator("sess-1");
  const [action] = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-unknown", sourceEventId: "evt-1" }],
  });
  assert.equal(action?.kind, "approval");
  if (action?.kind !== "approval") return;
  assert.equal(action.approval.toolLabel, "unknown tool");
  // Arguments are left empty rather than filled with a placeholder, and the
  // source event is carried through so the follower can fetch the real call.
  assert.equal(action.approval.arguments, "");
  assert.equal(action.approval.sourceEventId, "evt-1");
});

test("tool arguments are truncated rather than flooding the thread", () => {
  const t = createTranslator("sess-1");
  const huge = JSON.stringify({ manifest: "x".repeat(5000) });
  t.handle(modelMessage({ toolCalls: [toolCall("call-big", "kubernetes", "apply", huge)] }));
  const [action] = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-big", sourceEventId: "evt-1" }],
  });
  if (action?.kind !== "approval") { assert.fail("expected an approval"); return; }
  assert.ok(action.approval.arguments.length < 800);
  assert.match(action.approval.arguments, /more characters/);
});

/** A system tool call, as the harness emits ask_user_question. */
function systemCall(id: string, name: string, args: string): TrueForgeApi.ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
    toolInfo: { type: "truefoundry-system", name },
  };
}

test("a question the agent asks is rendered, not swallowed", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [systemCall("call-q", "ask_user_question",
      '{"question":"Which Slack channel should this post to?","options":["#ops","#alerts"]}')],
  }));

  const actions = t.handle({
    type: "tool.response_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-q", sourceEventId: "evt-1" }],
  });

  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action?.kind, "question");
  if (action?.kind !== "question") return;
  assert.equal(action.question.question, "Which Slack channel should this post to?");
  assert.deepEqual(action.question.options, ["#ops", "#alerts"]);
  assert.equal(action.question.toolCallId, "call-q");
});

test("a turn paused on a question is not treated as finished", () => {
  // Same trap as the approval case: `turn.done` reports status "done" while
  // waiting, and treating that as the end strands the question unanswered.
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [systemCall("call-q", "ask_user_question", '{"question":"Which environment?"}')],
  }));

  const actions = t.handle(donePausedOnQuestion());
  assert.equal(actions.some((a) => a.kind === "done"), false, "a pause is not the end of the session");
  assert.ok(actions.find((a) => a.kind === "question"), "the pending question is prompted from turn.done");
});

test("a question already prompted mid-stream is not asked again on pause", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [systemCall("call-q", "ask_user_question", '{"question":"Which environment?"}')],
  }));
  t.handle({
    type: "tool.response_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-q", sourceEventId: "evt-1" }],
  });

  const actions = t.handle(donePausedOnQuestion());
  assert.equal(actions.filter((a) => a.kind === "question").length, 0, "asked once, not twice");
});

test("a malformed question payload still reaches a human", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    content: "I need to know which environment before I build this.",
    toolCalls: [systemCall("call-q", "ask_user_question", "not json at all")],
  }));

  const actions = t.handle({
    type: "tool.response_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:01:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-q", sourceEventId: "evt-1" }],
  });

  const [action] = actions;
  assert.equal(action?.kind, "question");
  if (action?.kind !== "question") return;
  // Falls back to the agent's own words rather than posting an empty prompt.
  assert.match(action.question.question, /which environment/i);
  assert.deepEqual(action.question.options, []);
});

test("a pause this surface cannot render ends the thread instead of spinning", () => {
  // Previously returned a status line that never cleared, so the thread looked
  // busy forever. mcp.auth_required is the live example.
  const t = createTranslator("sess-1");
  const actions = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:02:00Z",
    threadId: "main",
    state: {
      status: "done",
      output: null,
      requiredActions: [{
        type: "mcp.auth_required",
        id: "ra-9",
        createdAt: "2026-08-25T10:02:00Z",
        threadId: "main",
      }],
      completedAt: "2026-08-25T10:02:00Z",
    },
  } as TrueForgeApi.TurnStreamingEvent);

  const done = actions.find((a) => a.kind === "done");
  assert.ok(done, "the thread is closed rather than left spinning");
  if (done?.kind !== "done") return;
  assert.equal(done.ok, false);
  assert.match(String(done.detail), /mcp\.auth_required/);
  const message = actions.find((a) => a.kind === "message");
  assert.ok(message, "and it says what it was waiting on");
});

test("a finished turn posts the final answer, then marks the session done", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({ content: "IMPACT\n  demo-service is returning 5xx." }));
  const actions = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:05:00Z",
    threadId: null,
    state: {
      status: "done",
      completedAt: "2026-08-25T10:05:00Z",
      output: null,
      requiredActions: [],
    },
  });
  assert.deepEqual(actions, [
    { kind: "message", text: "IMPACT\n  demo-service is returning 5xx." },
    { kind: "done", ok: true, detail: null },
  ]);
});

test("a turn paused at an approval gate is not treated as finished", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [toolCall("call-7", "kubernetes", "patch_deployment", '{"replicas":1}')],
  }));

  const actions = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:05:00Z",
    threadId: null,
    state: {
      status: "done",
      completedAt: "2026-08-25T10:05:00Z",
      output: null,
      requiredActions: [{
        type: "tool.approval_required",
        id: "evt-2",
        createdAt: "2026-08-25T10:04:00Z",
        threadId: "main",
        toolCalls: [{ id: "call-7", sourceEventId: "evt-1" }],
      }],
    },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.kind, "approval", "a pause must prompt, not close the thread");
  assert.ok(!actions.some((a) => a.kind === "done"), "the session stays open");
});

test("an approval already prompted mid-stream is not prompted again on pause", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({
    toolCalls: [toolCall("call-7", "kubernetes", "patch_deployment", "{}")],
  }));
  const pending = {
    type: "tool.approval_required" as const,
    id: "evt-2",
    createdAt: "2026-08-25T10:04:00Z",
    threadId: "main",
    toolCalls: [{ id: "call-7", sourceEventId: "evt-1" }],
  };

  const streamed = t.handle(pending);
  assert.equal(streamed.length, 1);

  const onPause = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:05:00Z",
    threadId: null,
    state: {
      status: "done",
      completedAt: "2026-08-25T10:05:00Z",
      output: null,
      requiredActions: [pending],
    },
  });

  assert.deepEqual(onPause, [{ kind: "status", text: "Waiting on a pending action…" }]);
});

test("a finished turn prefers the turn's own output over remembered text", () => {
  const t = createTranslator("sess-1");
  t.handle(modelMessage({ content: "thinking out loud" }));
  const actions = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:05:00Z",
    threadId: null,
    state: {
      status: "done",
      completedAt: "2026-08-25T10:05:00Z",
      output: modelMessage({ id: "evt-final", content: "VERIFY\n  5xx ratio 0.9% (threshold 5%)" }),
      requiredActions: [],
    },
  });
  assert.deepEqual(actions, [
    { kind: "message", text: "VERIFY\n  5xx ratio 0.9% (threshold 5%)" },
    { kind: "done", ok: true, detail: null },
  ]);
});

test("a failed turn surfaces the harness error", () => {
  const t = createTranslator("sess-1");
  const actions = t.handle({
    type: "turn.done",
    id: "evt-3",
    createdAt: "2026-08-25T10:05:00Z",
    threadId: null,
    state: { status: "error", completedAt: "2026-08-25T10:05:00Z", message: "model provider timeout" },
  });
  assert.deepEqual(actions, [{ kind: "done", ok: false, detail: "Session failed: model provider timeout" }]);
});

test("streaming deltas are ignored so the status line does not thrash", () => {
  const t = createTranslator("sess-1");
  const actions = t.handle({
    type: "model.message.delta",
    id: "evt-4",
    createdAt: "2026-08-25T10:00:01Z",
    threadId: "main",
    delta: { content: "partial" },
  } as unknown as TrueForgeApi.TurnStreamingEvent);
  assert.deepEqual(actions, []);
});

test("chunkText splits long output on paragraph boundaries", () => {
  const paragraphs = ["a".repeat(1400), "b".repeat(1400), "c".repeat(1400)].join("\n\n");
  const chunks = chunkText(paragraphs, 3000);
  // Two paragraphs fit in the first chunk (1400 + 2 + 1400), the third does not.
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3000));
  assert.equal(chunks.join("").replace(/\n/g, "").length, 4200);
});

test("chunkText hard-splits a paragraph that cannot fit", () => {
  const chunks = chunkText("x".repeat(7000), 3000);
  assert.deepEqual(chunks.map((c) => c.length), [3000, 3000, 1000]);
});

test("short text is returned unchanged", () => {
  assert.deepEqual(chunkText("hello", 3000), ["hello"]);
});

test("an approval carries the agent's reasoning for that specific call", () => {
  const t = createTranslator("sess-1");
  t.handle({
    type: "model.message",
    id: "evt-1",
    createdAt: "2026-08-25T10:00:00Z",
    threadId: "main",
    finishReason: "tool_calls",
    content: "Rollout 47 raised 5xx from 0.1% to 18%. Rolling back to 46, which was healthy.",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "rollback_application", arguments: '{"app":"demo-service"}' },
        toolInfo: { type: "mcp", serverName: "argocd", name: "rollback_application" },
      },
    ],
  } as never);

  const [action] = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:00:01Z",
    threadId: "main",
    toolCalls: [{ id: "call-1", sourceEventId: "evt-1" }],
  });

  assert.equal(action?.kind, "approval");
  if (action?.kind !== "approval") return;
  assert.equal(action.approval.toolLabel, "argocd.rollback_application");
  assert.match(action.approval.rationale, /Rolling back to 46/);
  assert.match(action.approval.arguments, /demo-service/);
});

test("a tool call with no narration falls back to the agent's last words", () => {
  const t = createTranslator("sess-1");
  t.handle({
    type: "model.message",
    id: "evt-0",
    createdAt: "2026-08-25T10:00:00Z",
    threadId: "main",
    finishReason: "stop",
    content: "The deploy at 09:58 is the only change in the window.",
  } as never);
  t.handle({
    type: "model.message",
    id: "evt-1",
    createdAt: "2026-08-25T10:00:01Z",
    threadId: "main",
    finishReason: "tool_calls",
    content: "",
    toolCalls: [
      {
        id: "call-2",
        type: "function",
        function: { name: "sync", arguments: "{}" },
        toolInfo: { type: "mcp", serverName: "argocd", name: "sync" },
      },
    ],
  } as never);

  const [action] = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:00:02Z",
    threadId: "main",
    toolCalls: [{ id: "call-2", sourceEventId: "evt-1" }],
  });
  assert.equal(action?.kind, "approval");
  if (action?.kind !== "approval") return;
  assert.match(action.approval.rationale, /only change in the window/);
});

test("a proxied MCP call is labelled by the tool it actually invokes", () => {
  const t = createTranslator("sess-proxy");
  t.handle({
    type: "model.message",
    id: "evt-1",
    createdAt: "2026-08-25T10:00:00Z",
    threadId: "main",
    finishReason: "tool_calls",
    content: "Rolling back the bad sync.",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        // How the harness actually proxies MCP calls: the useful name is inside.
        function: {
          name: "call_tool",
          arguments: JSON.stringify({
            mcp_server: "argocd",
            tool_name: "rollback_application",
            input: { app: "demo-service" },
          }),
        },
        toolInfo: { type: "truefoundry-system", name: "call_tool" },
      },
    ],
  } as never);

  const [action] = t.handle({
    type: "tool.approval_required",
    id: "evt-2",
    createdAt: "2026-08-25T10:00:01Z",
    threadId: "main",
    toolCalls: [{ id: "call-1", sourceEventId: "evt-1" }],
  });
  assert.equal(action?.kind, "approval");
  if (action?.kind !== "approval") return;
  assert.equal(action.approval.toolLabel, "argocd.rollback_application");
});

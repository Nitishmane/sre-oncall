import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { openStore } from "../src/store.ts";
import { createPipeline } from "../src/pipeline.ts";
import { createApp } from "../src/server.ts";
import type { Harness } from "../src/trueforge.ts";

const WEBHOOK_BEARER = "w".repeat(32);
const BRIDGE_BEARER = "b".repeat(32);

function bootServer() {
  const config = loadConfig({
    GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
    TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
  } as NodeJS.ProcessEnv);
  const store = openStore(":memory:");
  const prompts: string[] = [];
  const harness = {
    startSession: async (prompt: string) => { prompts.push(prompt); return { sessionId: "sess-1", turnId: "turn-1" }; },
    health: async () => true,
  } as unknown as Harness;
  const pipeline = createPipeline({ config, log: createLogger("error"), store, harness, sleep: async () => {} });
  const app = createApp({ config, log: createLogger("error"), store, pipeline, harness });
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    close: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const firingBody = {
  status: "firing",
  orgId: 1,
  alerts: [{
    status: "firing",
    labels: { alertname: "HighErrorRate", __alert_rule_uid__: "rule-1" },
    annotations: {},
    fingerprint: "fp-http-1",
    startsAt: "2026-08-25T10:00:00Z",
  }],
};

test("the webhook rejects an unauthenticated caller", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/webhook/grafana`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firingBody),
    });
    assert.equal(res.status, 401);
    assert.equal(srv.prompts.length, 0, "no session may start without the bearer");
  } finally {
    await srv.close();
  }
});

test("the webhook rejects a wrong bearer", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/webhook/grafana`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"z".repeat(32)}` },
      body: JSON.stringify(firingBody),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("the webhook accepts a verified alert and answers fast", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/webhook/grafana`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WEBHOOK_BEARER}` },
      body: JSON.stringify(firingBody),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as { accepted: number };
    assert.equal(body.accepted, 1);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(srv.prompts.length, 1);
  } finally {
    await srv.close();
  }
});

test("a malformed body is refused without touching the harness", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/webhook/grafana`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WEBHOOK_BEARER}` },
      body: JSON.stringify({ alerts: [{ status: "exploded" }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(srv.prompts.length, 0);
  } finally {
    await srv.close();
  }
});

test("the chat bridge and incident list require the bridge bearer, not the webhook one", async () => {
  const srv = bootServer();
  try {
    const withWebhookToken = await fetch(`${srv.url}/incidents`, {
      headers: { authorization: `Bearer ${WEBHOOK_BEARER}` },
    });
    assert.equal(withWebhookToken.status, 401, "the two bearers are not interchangeable");

    const withBridgeToken = await fetch(`${srv.url}/incidents`, {
      headers: { authorization: `Bearer ${BRIDGE_BEARER}` },
    });
    assert.equal(withBridgeToken.status, 200);

    const unauthenticatedChat = await fetch(`${srv.url}/chat/api/sessions`);
    assert.equal(unauthenticatedChat.status, 401);
  } finally {
    await srv.close();
  }
});

test("an on-demand handoff starts a session and defaults to a 24-hour window", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE_BEARER}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as { sessionId: string; windowHours: number };
    assert.equal(body.sessionId, "sess-1");
    assert.equal(body.windowHours, 24);
    assert.match(srv.prompts[0]!, /last 24 hours/);
  } finally {
    await srv.close();
  }
});

test("an on-demand handoff honors a caller-supplied window, clamped to a sane range", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE_BEARER}` },
      body: JSON.stringify({ windowHours: 999999 }),
    });
    const body = await res.json() as { windowHours: number };
    assert.equal(body.windowHours, 24 * 30, "clamped to the same ceiling as /incidents and /approvals");
  } finally {
    await srv.close();
  }
});

test("the handoff endpoint requires the bridge bearer, not the webhook one", async () => {
  const srv = bootServer();
  try {
    const unauthenticated = await fetch(`${srv.url}/handoff`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const wrongBearer = await fetch(`${srv.url}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${WEBHOOK_BEARER}` },
    });
    assert.equal(wrongBearer.status, 401);
    assert.equal(srv.prompts.length, 0);
  } finally {
    await srv.close();
  }
});

test("healthz is open, and reports queue depth", async () => {
  const srv = bootServer();
  try {
    const res = await fetch(`${srv.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; active: number };
    assert.equal(body.ok, true);
    assert.equal(body.active, 0);
  } finally {
    await srv.close();
  }
});

test("empty optional credentials mean 'not configured', not 'invalid'", () => {
  // This is how a `.env` copied from the template arrives: keys present, values
  // empty. It must not fail validation.
  const config = loadConfig({
    GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
    TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    SLACK_INCIDENT_CHANNEL: "",
    TRUEFORGE_TOKEN: "",
    SLACK_APPROVER_IDS: "",
  } as NodeJS.ProcessEnv);

  assert.equal(config.SLACK_BOT_TOKEN, undefined);
  assert.equal(config.slackEnabled, false);
  assert.deepEqual(config.SLACK_APPROVER_IDS, []);
});

test("a malformed Slack token is still rejected", () => {
  assert.throws(
    () => loadConfig({
      GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
      TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
      SLACK_BOT_TOKEN: "definitely-not-a-slack-token",
      SLACK_APP_TOKEN: "xapp-1-A",
    } as NodeJS.ProcessEnv),
    /SLACK_BOT_TOKEN/,
  );
});

test("an unset handoff interval disables the schedule without failing validation", () => {
  const config = loadConfig({
    GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
    TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
    HANDOFF_INTERVAL_HOURS: "",
  } as NodeJS.ProcessEnv);
  assert.equal(config.HANDOFF_INTERVAL_HOURS, undefined);
});

test("a configured handoff interval is coerced to a number", () => {
  const config = loadConfig({
    GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
    TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
    HANDOFF_INTERVAL_HOURS: "12",
  } as NodeJS.ProcessEnv);
  assert.equal(config.HANDOFF_INTERVAL_HOURS, 12);
});

test("approver ids are parsed and trimmed", () => {
  const config = loadConfig({
    GRAFANA_WEBHOOK_BEARER: WEBHOOK_BEARER,
    TRUEFORGE_BRIDGE_TOKEN: BRIDGE_BEARER,
    SLACK_APPROVER_IDS: "U_ALICE, U_BOB ,,U_CAROL",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.SLACK_APPROVER_IDS, ["U_ALICE", "U_BOB", "U_CAROL"]);
});

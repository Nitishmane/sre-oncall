import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { openStore, type Store } from "../src/store.ts";
import { createPipeline } from "../src/pipeline.ts";
import type { NormalizedAlert } from "../src/alerts/payload.ts";
import type { Harness } from "../src/trueforge.ts";

const silent = createLogger("error");

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    GRAFANA_WEBHOOK_BEARER: "x".repeat(32),
    TRUEFORGE_BRIDGE_TOKEN: "y".repeat(32),
    ALERT_FLAP_DELAY_SECONDS: "30",
    POSTMORTEM_DELAY_SECONDS: "60",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function fakeHarness() {
  const prompts: string[] = [];
  let counter = 0;
  const harness = {
    startSession: async (prompt: string) => {
      prompts.push(prompt);
      counter += 1;
      return `sess-${counter}`;
    },
  } as unknown as Harness;
  return { harness, prompts };
}

function alert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    status: "firing",
    ruleUid: "rule-uid-1",
    fingerprint: "fp-1",
    ruleName: "HighErrorRate",
    orgId: 1,
    startsAt: "2026-08-25T10:00:00Z",
    endsAt: null,
    ...overrides,
  };
}

/** Runs the pipeline with a controllable clock and an instant sleep. */
function harnessUnderTest(config: Config, store: Store) {
  const { harness, prompts } = fakeHarness();
  let clock = 1_000_000;
  const slept: number[] = [];
  const pipeline = createPipeline({
    config,
    log: silent,
    store,
    harness,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); },
  });
  return { pipeline, prompts, slept, advance: (ms: number) => { clock += ms; } };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("a firing alert starts one healing session", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(testConfig(), store);

  pipeline.ingest([alert()]);
  await settle();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /alert_rule_uid: rule-uid-1/);
  assert.match(prompts[0]!, /fingerprint: fp-1/);
  assert.equal(store.get("fp-1")?.healing_session_id, "sess-1");
  store.close();
});

test("the healing prompt frames identifiers only", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(testConfig(), store);
  pipeline.ingest([alert({ ruleName: "HighErrorRate" })]);
  await settle();
  assert.doesNotMatch(prompts[0]!, /HighErrorRate/, "rule name is policy input, not prompt input");
  store.close();
});

test("a repeat of the same alert is suppressed by the cooldown", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(testConfig({ ALERT_COOLDOWN_SECONDS: "3600" }), store);

  pipeline.ingest([alert()]);
  await settle();
  pipeline.ingest([alert()]);
  await settle();

  assert.equal(prompts.length, 1, "second firing within the cooldown is dropped");
  store.close();
});

test("the cooldown expires", async () => {
  const store = openStore(":memory:");
  const t = harnessUnderTest(testConfig({ ALERT_COOLDOWN_SECONDS: "600" }), store);

  t.pipeline.ingest([alert()]);
  await settle();
  t.advance(601_000);
  t.pipeline.ingest([alert()]);
  await settle();

  assert.equal(t.prompts.length, 2);
  store.close();
});

test("skip patterns keep heartbeat alerts out of the harness", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(testConfig(), store);
  pipeline.ingest([alert({ ruleName: "Watchdog", fingerprint: "fp-watchdog" })]);
  await settle();
  assert.equal(prompts.length, 0);
  store.close();
});

test("the hourly rate limit caps an alert storm", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(
    testConfig({ ALERT_MAX_PER_HOUR: "3", MAX_CONCURRENT_SESSIONS: "5" }),
    store,
  );

  for (let i = 0; i < 6; i += 1) {
    pipeline.ingest([alert({ fingerprint: `fp-storm-${i}` })]);
    await settle();
  }

  assert.equal(prompts.length, 3);
  store.close();
});

test("delay-pattern alerts wait, then heal if still firing", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts, slept } = harnessUnderTest(
    testConfig({ ALERT_DELAY_PATTERNS: "^HighErrorRate$" }),
    store,
  );

  pipeline.ingest([alert()]);
  await settle();

  assert.deepEqual(slept, [30_000]);
  assert.equal(prompts.length, 1);
  store.close();
});

test("an alert that self-resolves during the flap delay is never triaged", async () => {
  const store = openStore(":memory:");
  const { harness, prompts } = fakeHarness();
  const config = testConfig({ ALERT_DELAY_PATTERNS: "^HighErrorRate$" });
  let releaseDelay!: () => void;
  const delayHeld = new Promise<void>((resolve) => { releaseDelay = resolve; });

  const pipeline = createPipeline({
    config, log: silent, store, harness,
    now: () => 1_000_000,
    sleep: () => delayHeld,
  });

  pipeline.ingest([alert()]);
  await settle();
  assert.equal(prompts.length, 0, "still holding");

  // The alert resolves while we hold it — recorded by the resolved webhook.
  store.recordSeen({ ...alert({ status: "resolved" }), status: "resolved" }, 1_000_500);
  releaseDelay();
  await settle();

  assert.equal(prompts.length, 0, "self-resolved alerts are dropped silently");
  store.close();
});

test("resolved alerts produce a postmortem only after a healing session", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts, slept } = harnessUnderTest(testConfig(), store);

  // Resolve something we never healed: no postmortem.
  pipeline.ingest([alert({ status: "resolved", fingerprint: "fp-unhealed", endsAt: "2026-08-25T10:05:00Z" })]);
  await settle();
  assert.equal(prompts.length, 0);

  // Heal, then resolve: postmortem, after the settle delay.
  pipeline.ingest([alert()]);
  await settle();
  pipeline.ingest([alert({ status: "resolved", endsAt: "2026-08-25T10:30:00Z" })]);
  await settle();

  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Grafana alert has resolved/);
  assert.match(prompts[1]!, /healing_session_id: sess-1/);
  assert.deepEqual(slept, [60_000]);
  assert.equal(store.get("fp-1")?.postmortem_session_id, "sess-2");
  store.close();
});

test("a postmortem is written once per incident", async () => {
  const store = openStore(":memory:");
  const { pipeline, prompts } = harnessUnderTest(testConfig(), store);

  pipeline.ingest([alert()]);
  await settle();
  pipeline.ingest([alert({ status: "resolved", endsAt: "2026-08-25T10:30:00Z" })]);
  await settle();
  pipeline.ingest([alert({ status: "resolved", endsAt: "2026-08-25T10:30:00Z" })]);
  await settle();

  assert.equal(prompts.length, 2, "the duplicate resolved delivery is ignored");
  store.close();
});

test("firing and resolved for one fingerprint never run concurrently", async () => {
  const store = openStore(":memory:");
  const order: string[] = [];
  let releaseHealing!: () => void;
  const healingHeld = new Promise<void>((resolve) => { releaseHealing = resolve; });

  const harness = {
    startSession: async (prompt: string) => {
      const kind = prompt.startsWith("A Grafana alert is firing") ? "healing" : "postmortem";
      order.push(`${kind}-start`);
      if (kind === "healing") await healingHeld;
      order.push(`${kind}-end`);
      return `sess-${order.length}`;
    },
  } as unknown as Harness;

  const pipeline = createPipeline({
    config: testConfig(), log: silent, store, harness,
    now: () => 1_000_000,
    sleep: async () => {},
  });

  pipeline.ingest([alert()]);
  pipeline.ingest([alert({ status: "resolved", endsAt: "2026-08-25T10:30:00Z" })]);
  await settle();

  assert.deepEqual(order, ["healing-start"], "the postmortem waits behind the healing session");
  releaseHealing();
  await settle();
  assert.deepEqual(order, ["healing-start", "healing-end", "postmortem-start", "postmortem-end"]);
  store.close();
});

test("a failing session does not wedge the fingerprint's queue", async () => {
  const store = openStore(":memory:");
  let calls = 0;
  const harness = {
    startSession: async () => {
      calls += 1;
      if (calls === 1) throw new Error("harness down");
      return "sess-ok";
    },
  } as unknown as Harness;

  let clock = 1_000_000;
  const pipeline = createPipeline({
    config: testConfig({ ALERT_COOLDOWN_SECONDS: "0" }),
    log: silent, store, harness,
    now: () => clock,
    sleep: async () => {},
  });

  pipeline.ingest([alert()]);
  await settle();
  clock += 1000;
  pipeline.ingest([alert()]);
  await settle();

  assert.equal(calls, 2, "the next delivery still gets through");
  assert.equal(store.get("fp-1")?.healing_session_id, "sess-ok");
  store.close();
});

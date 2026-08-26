import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";
import { startHandoffScheduler } from "../src/scheduler.ts";
import type { Pipeline } from "../src/pipeline.ts";

const silent = createLogger("error");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A sleep that only resolves when the test calls the returned `advance`. */
function controllableSleep() {
  const waiters: Array<{ ms: number; resolve: () => void }> = [];
  const calls: number[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      calls.push(ms);
      waiters.push({ ms, resolve });
    });
  return {
    sleep,
    calls,
    /** Resolves the oldest pending sleep, as if its timer had fired. */
    advance: () => {
      const next = waiters.shift();
      if (!next) throw new Error("no pending sleep to advance");
      next.resolve();
    },
  };
}

test("the schedule waits a full interval before the first handoff", async () => {
  const runs: number[] = [];
  const pipeline = { runHandoff: async (hours: number) => { runs.push(hours); return "sess-1"; } } as unknown as Pipeline;
  const control = controllableSleep();

  const scheduler = startHandoffScheduler({ pipeline, log: silent, intervalHours: 12, sleep: control.sleep });
  await tick();

  assert.deepEqual(control.calls, [12 * 3_600_000], "sleeps for one interval before running anything");
  assert.deepEqual(runs, [], "no handoff yet");

  scheduler.stop();
  control.advance();
  await scheduler.done;
});

test("each elapsed interval starts one handoff covering that interval", async () => {
  const runs: number[] = [];
  const pipeline = { runHandoff: async (hours: number) => { runs.push(hours); return "sess-1"; } } as unknown as Pipeline;
  const control = controllableSleep();

  const scheduler = startHandoffScheduler({ pipeline, log: silent, intervalHours: 6, sleep: control.sleep });

  control.advance();
  await tick();
  assert.deepEqual(runs, [6]);

  control.advance();
  await tick();
  assert.deepEqual(runs, [6, 6]);

  scheduler.stop();
  control.advance();
  await scheduler.done;
});

test("stop() prevents any further handoff, even one already mid-sleep", async () => {
  const runs: number[] = [];
  const pipeline = { runHandoff: async (hours: number) => { runs.push(hours); return "sess-1"; } } as unknown as Pipeline;
  const control = controllableSleep();

  const scheduler = startHandoffScheduler({ pipeline, log: silent, intervalHours: 12, sleep: control.sleep });
  scheduler.stop();
  control.advance();
  await scheduler.done;

  assert.deepEqual(runs, [], "stopping during the wait cancels the run that would have followed it");
});

test("a harness failure is logged, not thrown, and does not stop the schedule", async () => {
  let calls = 0;
  const pipeline = {
    runHandoff: async () => {
      calls += 1;
      throw new Error("harness down");
    },
  } as unknown as Pipeline;
  const control = controllableSleep();

  const scheduler = startHandoffScheduler({ pipeline, log: silent, intervalHours: 1, sleep: control.sleep });

  control.advance();
  await tick();
  assert.equal(calls, 1);

  control.advance();
  await tick();
  assert.equal(calls, 2, "one failed run does not wedge the loop");

  scheduler.stop();
  control.advance();
  await scheduler.done;
});

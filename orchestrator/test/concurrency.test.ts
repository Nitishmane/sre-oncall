import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedQueue, createSemaphore } from "../src/concurrency.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("keyed queue serializes work sharing a key", async () => {
  const queue = createKeyedQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const a = queue.enqueue("fp-1", async () => { order.push("a-start"); await first; order.push("a-end"); });
  const b = queue.enqueue("fp-1", async () => { order.push("b-start"); });

  await tick();
  assert.deepEqual(order, ["a-start"], "b must not start while a is in flight");
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("keyed queue runs different keys concurrently", async () => {
  const queue = createKeyedQueue();
  const started: string[] = [];
  const never = new Promise<void>(() => {});

  void queue.enqueue("fp-1", async () => { started.push("one"); await never; });
  void queue.enqueue("fp-2", async () => { started.push("two"); await never; });

  await tick();
  assert.deepEqual(started, ["one", "two"]);
});

test("keyed queue forgets a key once its chain drains", async () => {
  const queue = createKeyedQueue();
  await queue.enqueue("fp-1", async () => {});
  await tick();
  assert.equal(queue.depth, 0);
});

test("keyed queue keeps ordering after a failure", async () => {
  const queue = createKeyedQueue();
  const order: string[] = [];
  const failed = queue.enqueue("fp-1", async () => { order.push("boom"); throw new Error("boom"); });
  const after = queue.enqueue("fp-1", async () => { order.push("after"); });

  await assert.rejects(failed, /boom/);
  await after;
  assert.deepEqual(order, ["boom", "after"]);
});

test("semaphore caps concurrent runs and drains the waiters", async () => {
  const slots = createSemaphore(2);
  const releases: Array<() => void> = [];
  const blocked = () => new Promise<void>((resolve) => releases.push(resolve));

  const runs = [slots.run(blocked), slots.run(blocked), slots.run(blocked)];
  await tick();
  assert.equal(slots.active, 2);
  assert.equal(slots.queued, 1);

  releases[0]?.();
  await tick();
  assert.equal(slots.queued, 0, "third run takes the freed slot");

  releases[1]?.();
  releases[2]?.();
  await Promise.all(runs);
  assert.equal(slots.active, 0);
});

test("semaphore releases the slot when the task throws", async () => {
  const slots = createSemaphore(1);
  await assert.rejects(slots.run(async () => { throw new Error("nope"); }), /nope/);
  assert.equal(slots.active, 0);
  await slots.run(async () => {});
});

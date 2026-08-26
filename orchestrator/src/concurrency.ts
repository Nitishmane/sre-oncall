/**
 * Two-layer concurrency control, ported from the reference implementation
 * (research/reference-agent-analysis.md §c):
 *
 *   Layer 1 — per-key promise chain: work for the same alert fingerprint runs
 *             strictly in order, never concurrently. A `firing` and its
 *             `resolved` follow-up can't race each other.
 *   Layer 2 — global slot semaphore: caps how many healing sessions the
 *             harness runs at once during an alert storm.
 */

export function createKeyedQueue() {
  const chains = new Map<string, Promise<void>>();

  function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    let done!: Promise<void>;
    const result = new Promise<T>((resolve, reject) => {
      done = previous.then(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
    });
    chains.set(key, done);
    void done.then(() => {
      // Only clear if no later work chained onto this same promise.
      if (chains.get(key) === done) chains.delete(key);
    });
    return result;
  }

  return { enqueue, get depth() { return chains.size; } };
}

export function createSemaphore(maxConcurrent: number) {
  if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
  let active = 0;
  const waiting: Array<() => void> = [];

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  function acquire(): Promise<() => void> {
    let released = false;
    const guard = () => {
      if (released) return;
      released = true;
      release();
    };
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(guard);
    }
    return new Promise((resolve) => {
      waiting.push(() => resolve(guard));
    });
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const guard = await acquire();
    try {
      return await fn();
    } finally {
      guard();
    }
  }

  return {
    acquire,
    run,
    get active() { return active; },
    get queued() { return waiting.length; },
  };
}

export type KeyedQueue = ReturnType<typeof createKeyedQueue>;
export type Semaphore = ReturnType<typeof createSemaphore>;

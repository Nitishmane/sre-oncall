/**
 * Fault configuration, read from the environment at startup.
 *
 * The faults are set by a ConfigMap that the deployment mounts as env vars, so
 * "injecting a fault" is a real Kubernetes change with a real rollout — which is
 * exactly what the agent has to discover and undo. Nothing here reads a control
 * endpoint at runtime: a live toggle would let the demo cheat.
 */
export interface Faults {
  /** Fraction of requests answered with 500. */
  errorRate: number;
  /** Extra milliseconds added to every response. */
  latencyMs: number;
  /** Megabytes leaked per minute — drives the container toward its memory limit. */
  leakMbPerMinute: number;
  /** When true, the process exits shortly after start, producing a crashloop. */
  crashOnStart: boolean;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadFaults(): Faults {
  return {
    errorRate: Math.min(num("FAULT_ERROR_RATE", 0), 1),
    latencyMs: num("FAULT_LATENCY_MS", 0),
    leakMbPerMinute: num("FAULT_LEAK_MB_PER_MINUTE", 0),
    crashOnStart: (process.env["FAULT_CRASH_ON_START"] ?? "") === "true",
  };
}

/** Holds allocated buffers so the garbage collector cannot reclaim them. */
export function startLeak(mbPerMinute: number): NodeJS.Timeout | null {
  if (mbPerMinute <= 0) return null;
  const ballast: Buffer[] = [];
  const everySeconds = 5;
  const bytesPerTick = Math.round((mbPerMinute * 1024 * 1024 * everySeconds) / 60);
  return setInterval(() => {
    // Fill the buffer: an untouched allocation may never be paged in, and the
    // container's working set is what the memory limit is enforced against.
    ballast.push(Buffer.alloc(bytesPerTick, 1));
  }, everySeconds * 1000);
}

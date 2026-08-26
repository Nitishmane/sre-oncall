import type { Logger } from "./logger.ts";
import type { Pipeline } from "./pipeline.ts";

/**
 * Fires an automatic handoff session every `intervalHours`, so a shift ends
 * with a written summary even if nobody remembers to ask for one. `POST
 * /handoff` (server.ts) covers the on-demand case; this covers the routine one.
 *
 * A plain repeating sleep, not `setInterval`: the loop only reschedules after
 * `runHandoff` settles, so a slow harness stretches the period instead of
 * stacking overlapping handoff sessions.
 */
export interface SchedulerDeps {
  pipeline: Pick<Pipeline, "runHandoff">;
  log: Logger;
  intervalHours: number;
  /** Injectable so tests never wait out a real interval. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export function startHandoffScheduler(deps: SchedulerDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      await sleep(deps.intervalHours * 3_600_000);
      if (stopped) return;
      try {
        await deps.pipeline.runHandoff(deps.intervalHours);
      } catch (err) {
        // A missed handoff is a lost report, not a lost incident — log and
        // keep the schedule running rather than letting one bad turn kill it.
        deps.log.error("scheduled handoff failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const done = loop();
  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}

export type HandoffScheduler = ReturnType<typeof startHandoffScheduler>;

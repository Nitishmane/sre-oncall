import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";
import type { Harness, StartedTurn } from "./trueforge.ts";
import { createKeyedQueue, createSemaphore } from "./concurrency.ts";
import { decideFiring, stillFiringAfterDelay } from "./alerts/filter.ts";
import { healingPrompt, postmortemPrompt, handoffPrompt } from "./prompts.ts";
import type { NormalizedAlert } from "./alerts/payload.ts";

/** Told about every session the pipeline starts, so surfaces can follow it. */
export type SessionListener = (started: {
  sessionId: string;
  turnId: string;
  kind: "healing" | "postmortem" | "handoff";
  ruleName: string;
  fingerprint: string;
}) => void;

export interface PipelineDeps {
  config: Config;
  log: Logger;
  store: Store;
  harness: Harness;
  now?: () => number;
  /** Injectable so tests don't wait out real flap delays. */
  sleep?: (ms: number) => Promise<void>;
  onSessionStarted?: SessionListener;
  /** Called the moment an alert resolves, so its announcement can be repainted. */
  onIncidentResolved?: (params: {
    fingerprint: string;
    ruleName: string;
    resolvedAt: Date;
  }) => void;
}

export interface AlertOutcome {
  fingerprint: string;
  action: "triage" | "delay" | "skip" | "postmortem";
  reason?: string;
  sessionId?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export function createPipeline(deps: PipelineDeps) {
  const { config, log, store, harness } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  // Layer 1: per-fingerprint ordering. Layer 2: global cap on concurrent sessions.
  const queue = createKeyedQueue();
  const slots = createSemaphore(config.MAX_CONCURRENT_SESSIONS);

  /** A surface that throws must not take an incident down with it. */
  function announce(
    started: StartedTurn,
    kind: "healing" | "postmortem" | "handoff",
    ruleName: string,
    fingerprint: string,
  ): void {
    try {
      deps.onSessionStarted?.({ ...started, kind, ruleName, fingerprint });
    } catch (err) {
      log.warn("session listener failed", {
        sessionId: started.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runHealing(alert: NormalizedAlert): Promise<AlertOutcome> {
    const decision = decideFiring(alert, { config, store, now });

    if (decision.action === "skip") {
      log.info("alert skipped", { fingerprint: alert.fingerprint, rule: alert.ruleName, reason: decision.reason });
      return { fingerprint: alert.fingerprint, action: "skip", reason: decision.reason };
    }

    if (decision.action === "delay") {
      log.info("alert held for flap delay", { fingerprint: alert.fingerprint, rule: alert.ruleName, seconds: decision.seconds });
      await sleep(decision.seconds * 1000);
      const recheck = stillFiringAfterDelay(alert, { config, store, now });
      if (recheck.action === "skip") {
        log.info("alert self-resolved during flap delay", { fingerprint: alert.fingerprint, reason: recheck.reason });
        return { fingerprint: alert.fingerprint, action: "skip", reason: recheck.reason };
      }
    }

    return slots.run(async () => {
      // Counted before the call: an attempt against a dead harness still costs
      // a slot in the hourly budget.
      // A fresh occurrence of an alert that had already been written up starts
      // its own thread. Released here rather than after the postmortem
      // announces: `announce` is fire-and-forget, so releasing next to it was a
      // race — the postmortem's own follower looked the thread up after it had
      // gone, and its RESOLVED summary never reached the channel.
      // `recordSeen` has already flipped the status to firing by now, so the
      // signal that this is a *new* occurrence is the previous one's write-up.
      if (store.get(alert.fingerprint)?.postmortem_session_id != null) {
        store.releaseIncidentThread(alert.fingerprint);
      }
      store.recordTriageAttempt(alert.fingerprint, now());
      const started = await harness.startSession(healingPrompt(alert, config.GITHUB_REPO), {
        kind: "healing",
        fingerprint: alert.fingerprint,
        rule: alert.ruleName,
      });
      store.recordTriage(alert.fingerprint, started.sessionId, now());
      announce(started, "healing", alert.ruleName, alert.fingerprint);
      return { fingerprint: alert.fingerprint, action: "triage" as const, sessionId: started.sessionId };
    });
  }

  async function runPostmortem(alert: NormalizedAlert): Promise<AlertOutcome> {
    // Repaint first, and unconditionally. This runs before the postmortem's
    // settle delay and regardless of whether a postmortem follows at all — an
    // alert that resolved without ever being healed still stops being red.
    try {
      deps.onIncidentResolved?.({
        fingerprint: alert.fingerprint,
        ruleName: alert.ruleName,
        resolvedAt: alert.endsAt !== null ? new Date(alert.endsAt) : new Date(now()),
      });
    } catch (err) {
      log.warn("resolved listener failed", {
        fingerprint: alert.fingerprint,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const incident = store.get(alert.fingerprint);
    if (incident?.healing_session_id == null) {
      // Nothing healed it — an alert that flapped or was silenced. No postmortem.
      log.info("resolved alert had no healing session; no postmortem", { fingerprint: alert.fingerprint });
      return { fingerprint: alert.fingerprint, action: "skip", reason: "no-healing-session" };
    }
    if (incident.postmortem_session_id != null) {
      return { fingerprint: alert.fingerprint, action: "skip", reason: "postmortem-exists" };
    }

    // Let the metric settle before asking the agent to describe the recovery.
    await sleep(config.POSTMORTEM_DELAY_SECONDS * 1000);

    return slots.run(async () => {
      const started = await harness.startSession(
        postmortemPrompt(
          alert,
          {
            healingSessionId: incident.healing_session_id,
            firstSeenAt: incident.first_seen_at,
            incidentStartedAt: incident.started_at,
            incidentResolvedAt: incident.resolved_at,
            healingStartedAt: incident.last_triaged_at,
          },
          config.GITHUB_REPO,
        ),
        { kind: "postmortem", fingerprint: alert.fingerprint, rule: alert.ruleName },
      );
      store.recordPostmortem(alert.fingerprint, started.sessionId);
      announce(started, "postmortem", alert.ruleName, alert.fingerprint);
      return { fingerprint: alert.fingerprint, action: "postmortem" as const, sessionId: started.sessionId };
    });
  }

  /**
   * Entry point for a verified webhook. Returns immediately with the routing
   * decision per alert; the sessions themselves run on the queue in the
   * background so Grafana's delivery isn't held open.
   */
  function ingest(alerts: NormalizedAlert[]): AlertOutcome[] {
    const accepted: AlertOutcome[] = [];
    for (const alert of alerts) {
      store.recordSeen(alert, now());
      const kind = alert.status === "firing" ? "healing" : "postmortem";
      accepted.push({ fingerprint: alert.fingerprint, action: alert.status === "firing" ? "triage" : "postmortem" });

      void queue
        .enqueue(alert.fingerprint, () => (alert.status === "firing" ? runHealing(alert) : runPostmortem(alert)))
        .catch((err: unknown) => {
          log.error("alert handling failed", {
            kind,
            fingerprint: alert.fingerprint,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return accepted;
  }

  async function runHandoff(windowHours: number): Promise<string> {
    return slots.run(async () => {
      const started = await harness.startSession(handoffPrompt(windowHours), {
        kind: "handoff",
        windowHours,
      });
      announce(started, "handoff", "OncallHandoff", "handoff");
      return started.sessionId;
    });
  }

  return {
    ingest,
    runHandoff,
    stats: () => ({ active: slots.active, queued: slots.queued, keys: queue.depth }),
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;

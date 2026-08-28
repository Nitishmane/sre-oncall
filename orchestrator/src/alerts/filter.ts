import type { Config } from "../config.ts";
import type { Store } from "../store.ts";
import type { NormalizedAlert } from "./payload.ts";

/**
 * Alert admission policy, ported from the reference agent's pre-filter design.
 * Every rejection is explicit so the reason can be logged and shown in the demo.
 */

export type Decision =
  | { action: "triage" }
  | { action: "delay"; seconds: number }
  | { action: "skip"; reason: SkipReason };

export type SkipReason =
  | "skip-pattern"
  | "cooldown"
  | "rate-limit"
  | "already-resolved";

export interface FilterDeps {
  config: Config;
  store: Store;
  now: () => number;
}

export function decideFiring(alert: NormalizedAlert, deps: FilterDeps): Decision {
  const { config, store } = deps;
  const now = deps.now();

  if (config.skipPattern?.test(alert.ruleName)) {
    return { action: "skip", reason: "skip-pattern" };
  }

  const existing = store.get(alert.fingerprint);
  if (existing?.last_triaged_at != null) {
    const elapsed = (now - existing.last_triaged_at) / 1000;
    if (elapsed < config.ALERT_COOLDOWN_SECONDS) {
      return { action: "skip", reason: "cooldown" };
    }
  }

  const hourAgo = now - 3_600_000;
  if (store.triagesSince(hourAgo) >= config.ALERT_MAX_PER_HOUR) {
    return { action: "skip", reason: "rate-limit" };
  }

  if (config.delayPattern?.test(alert.ruleName) && config.ALERT_FLAP_DELAY_SECONDS > 0) {
    return { action: "delay", seconds: config.ALERT_FLAP_DELAY_SECONDS };
  }

  return { action: "triage" };
}

/**
 * Re-checked after a flap delay elapses: if the alert resolved itself while we
 * held it, healing is pointless and we stay silent.
 */
export function stillFiringAfterDelay(alert: NormalizedAlert, deps: FilterDeps): Decision {
  const existing = deps.store.get(alert.fingerprint);
  if (existing?.status === "resolved") {
    return { action: "skip", reason: "already-resolved" };
  }
  return { action: "triage" };
}

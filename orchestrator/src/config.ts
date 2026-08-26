import { z } from "zod";

/**
 * Every knob the orchestrator reads. Secrets come from `.env` at the repo root
 * (gitignored) — never from files inside the repo.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATA_DIR: z.string().default(".data"),

  /** TrueForge harness (local mode listens on 8790). */
  TRUEFORGE_API_URL: z.string().url().default("http://127.0.0.1:8790"),
  TRUEFORGE_TOKEN: z.string().optional(),
  TRUEFORGE_AGENT_NAME: z.string().default("sre-oncall"),

  /** Bearer the Grafana/Alertmanager webhook contact point must present. */
  GRAFANA_WEBHOOK_BEARER: z.string().min(16),
  /** Bearer the Vercel chatbox must present on /chat/*. */
  TRUEFORGE_BRIDGE_TOKEN: z.string().min(16),

  /** Concurrency + alert-filter policy (ported from the reference agent). */
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(3),
  ALERT_MAX_PER_HOUR: z.coerce.number().int().positive().default(10),
  ALERT_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  ALERT_FLAP_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /** Regex (as a string) of alert rule names that are held for the flap delay. */
  ALERT_DELAY_PATTERNS: z.string().default(""),
  /** Regex (as a string) of alert rule names never auto-triaged. */
  ALERT_SKIP_PATTERNS: z.string().default("^Watchdog$"),
  /** Seconds to wait after `resolved` before drafting the postmortem. */
  POSTMORTEM_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(60),
});

export type Config = z.infer<typeof schema> & {
  skipPattern: RegExp | null;
  delayPattern: RegExp | null;
};

function toRegExp(source: string): RegExp | null {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  return new RegExp(trimmed, "i");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid orchestrator configuration:\n${detail}`);
  }
  return {
    ...parsed.data,
    skipPattern: toRegExp(parsed.data.ALERT_SKIP_PATTERNS),
    delayPattern: toRegExp(parsed.data.ALERT_DELAY_PATTERNS),
  };
}

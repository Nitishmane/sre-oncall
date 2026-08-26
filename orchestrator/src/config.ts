import { z } from "zod";

/**
 * Every knob the orchestrator reads. Secrets come from `.env` at the repo root
 * (gitignored) — never from files inside the repo.
 */
/**
 * A `.env` file spells "not configured" as `KEY=`, which reaches us as an empty
 * string rather than as `undefined`. Treat the two the same, or every optional
 * credential fails validation the moment someone copies the template.
 */
const optional = <T extends z.ZodType>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner.optional());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATA_DIR: z.string().default(".data"),

  /**
   * TrueForge harness. Local mode listens on `localhost:8790` — note that on
   * macOS it binds IPv6 only, so `127.0.0.1` will not connect. Use the name.
   */
  TRUEFORGE_API_URL: z.string().url().default("http://localhost:8790"),
  TRUEFORGE_TOKEN: optional(z.string()),
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

  /**
   * Hours between automatic on-call handoff sessions (e.g. 12 for a twice-daily
   * shift change). Unset disables the schedule — `POST /handoff` still works
   * on demand. A fixed interval, not a wall-clock time of day, so it needs no
   * timezone and is trivial to test with an injected clock; each run covers
   * the interval that just elapsed.
   */
  HANDOFF_INTERVAL_HOURS: optional(z.coerce.number().int().positive()),

  /** Slack (Socket Mode). Both tokens must be present for the bot to start. */
  SLACK_BOT_TOKEN: optional(z.string().startsWith("xoxb-")),
  SLACK_APP_TOKEN: optional(z.string().startsWith("xapp-")),
  /** Channel where alert-triggered sessions announce themselves. */
  SLACK_INCIDENT_CHANNEL: optional(z.string()),
  /**
   * Slack user IDs allowed to decide approval gates. When empty, any workspace
   * member may approve — the approval prompt says so out loud.
   */
  SLACK_APPROVER_IDS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((id) => id.trim()).filter((id) => id !== "")),
});

export type Config = z.infer<typeof schema> & {
  skipPattern: RegExp | null;
  delayPattern: RegExp | null;
  /** True when both Slack tokens are configured. */
  slackEnabled: boolean;
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
    slackEnabled:
      parsed.data.SLACK_BOT_TOKEN !== undefined && parsed.data.SLACK_APP_TOKEN !== undefined,
  };
}

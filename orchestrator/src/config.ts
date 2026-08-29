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

  /**
   * `owner/repo` that ArgoCD deploys from, so the agent knows where to open a
   * revert pull request. Operator-configured, which is why it may be framed
   * into a prompt: unlike an alert label, nobody but the operator can write it.
   */
  GITHUB_REPO: optional(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"')),

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
  /**
   * Channel ids the on-call bot answers mentions in. Empty means any channel,
   * which is the historical behaviour and stays the default. Set it when a
   * second bot shares the workspace and you want a hard boundary rather than
   * relying on who ran `/invite`.
   */
  SLACK_CHANNELS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((id) => id.trim()).filter((id) => id !== "")),

  /**
   * The automation bot: a second Slack app, its own bot user, its own Socket
   * Mode connection. Separate tokens rather than a second channel on the first
   * app, so it has its own identity and scopes.
   */
  SLACK_AUTOMATION_BOT_TOKEN: optional(z.string().startsWith("xoxb-")),
  SLACK_AUTOMATION_APP_TOKEN: optional(z.string().startsWith("xapp-")),
  /** The #automation-agent channel id. Unset means it answers anywhere. */
  SLACK_AUTOMATION_CHANNEL: optional(z.string()),
  /** Falls back to SLACK_APPROVER_IDS when empty — see buildSlackBots. */
  SLACK_AUTOMATION_APPROVER_IDS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((id) => id.trim()).filter((id) => id !== "")),
  /** Agent the automation bot's sessions run against. */
  TRUEFORGE_AUTOMATION_AGENT_NAME: z.string().default("automation-engineer"),
});

/**
 * One Slack bot: its credentials, the agent it drives, and where it may speak.
 *
 * Bots are data rather than code so that adding one is a config change. Every
 * Slack-specific field `createSlackApp` needs lives here, which is what makes
 * the app factory instantiable more than once.
 */
export interface SlackBotProfile {
  /** Short id, used in logs and to find the bot that owns the incident channel. */
  name: "oncall" | "automation";
  botToken: string;
  appToken: string;
  /** TrueForge agent this bot's chat sessions run against. */
  agentName: string;
  /** Channel ids it answers mentions in. Empty means anywhere. DMs always work. */
  channels: string[];
  /** Where alert-driven sessions announce. Only the on-call bot has one. */
  incidentChannel: string | undefined;
  approvers: string[];
}

export type Config = z.infer<typeof schema> & {
  skipPattern: RegExp | null;
  delayPattern: RegExp | null;
  /** True when at least one bot is fully configured. */
  slackEnabled: boolean;
  /** Every bot with a complete token pair. Empty means Slack is off. */
  slackBots: SlackBotProfile[];
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
  const slackBots = buildSlackBots(parsed.data);
  return {
    ...parsed.data,
    skipPattern: toRegExp(parsed.data.ALERT_SKIP_PATTERNS),
    delayPattern: toRegExp(parsed.data.ALERT_DELAY_PATTERNS),
    slackEnabled: slackBots.length > 0,
    slackBots,
  };
}

/**
 * A bot exists only with a complete token pair — half a pair is a
 * misconfiguration, and starting on it would fail at connect time with a much
 * worse message than simply not appearing.
 */
function buildSlackBots(data: z.infer<typeof schema>): SlackBotProfile[] {
  const bots: SlackBotProfile[] = [];

  if (data.SLACK_BOT_TOKEN !== undefined && data.SLACK_APP_TOKEN !== undefined) {
    bots.push({
      name: "oncall",
      botToken: data.SLACK_BOT_TOKEN,
      appToken: data.SLACK_APP_TOKEN,
      agentName: data.TRUEFORGE_AGENT_NAME,
      channels: data.SLACK_CHANNELS,
      incidentChannel: data.SLACK_INCIDENT_CHANNEL,
      approvers: data.SLACK_APPROVER_IDS,
    });
  }

  if (data.SLACK_AUTOMATION_BOT_TOKEN !== undefined && data.SLACK_AUTOMATION_APP_TOKEN !== undefined) {
    bots.push({
      name: "automation",
      botToken: data.SLACK_AUTOMATION_BOT_TOKEN,
      appToken: data.SLACK_AUTOMATION_APP_TOKEN,
      agentName: data.TRUEFORGE_AUTOMATION_AGENT_NAME,
      channels: data.SLACK_AUTOMATION_CHANNEL !== undefined ? [data.SLACK_AUTOMATION_CHANNEL] : [],
      // No incident channel: alerts belong to on-call, and announcing them in
      // the automation room would be noise nobody acts on.
      incidentChannel: undefined,
      // Inherit rather than default to unrestricted. Silently widening who may
      // approve, just because a second variable was forgotten, is the wrong way
      // to be wrong about an approval gate.
      approvers: data.SLACK_AUTOMATION_APPROVER_IDS.length > 0
        ? data.SLACK_AUTOMATION_APPROVER_IDS
        : data.SLACK_APPROVER_IDS,
    });
  }

  return bots;
}

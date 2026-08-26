import { z } from "zod";

/**
 * Grafana Alerting's webhook contact point and Alertmanager's `webhook_config`
 * emit near-identical bodies, so one schema accepts both. Everything we don't
 * explicitly need is ignored: nothing outside this schema ever reaches the agent.
 */
const alertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  fingerprint: z.string().optional(),
  generatorURL: z.string().optional(),
  dashboardURL: z.string().optional(),
  panelURL: z.string().optional(),
  silenceURL: z.string().optional(),
});

export const webhookPayloadSchema = z.object({
  status: z.enum(["firing", "resolved"]).optional(),
  alerts: z.array(alertSchema).default([]),
  groupKey: z.string().optional(),
  orgId: z.number().optional(),
  externalURL: z.string().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/**
 * The only alert-derived data allowed to leave this module.
 *
 * Trust boundary (reference analysis §f): labels and annotations are attacker-influenced
 * — anyone who can name a Kubernetes object can write into `alertname` or a
 * summary. We therefore carry identifiers ONLY, each one shape-validated, and
 * the agent re-fetches the real alert through the Grafana MCP.
 */
export interface NormalizedAlert {
  status: "firing" | "resolved";
  /** Grafana rule UID (`__alert_rule_uid__`), or null for Alertmanager-sourced alerts. */
  ruleUid: string | null;
  /** Stable per-alert hash Grafana/Alertmanager computes over the label set. */
  fingerprint: string;
  /** Rule name — used ONLY for skip/delay policy and storage, never framed into a prompt. */
  ruleName: string;
  /** Grafana org, defaults to 1. */
  orgId: number;
  startsAt: string | null;
  endsAt: string | null;
}

/** Identifiers must look like identifiers before we trust them anywhere. */
const IDENT = /^[A-Za-z0-9_.:-]{1,128}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{1,128}$/;

function sanitizeIdent(value: string | undefined, pattern: RegExp): string | null {
  if (value === undefined) return null;
  return pattern.test(value) ? value : null;
}

/**
 * Deterministic fallback fingerprint for senders that omit one: a hash of the
 * sorted label set, matching how Alertmanager derives its own.
 */
async function deriveFingerprint(labels: Record<string, string>): Promise<string> {
  const canonical = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function normalizeAlerts(payload: WebhookPayload): Promise<NormalizedAlert[]> {
  const orgId = payload.orgId ?? 1;
  return Promise.all(
    payload.alerts.map(async (alert) => {
      const fingerprint =
        sanitizeIdent(alert.fingerprint, FINGERPRINT) ?? (await deriveFingerprint(alert.labels));
      return {
        status: alert.status,
        ruleUid: sanitizeIdent(alert.labels["__alert_rule_uid__"], IDENT),
        fingerprint,
        ruleName: sanitizeIdent(alert.labels["alertname"], IDENT) ?? "unknown",
        orgId,
        startsAt: alert.startsAt ?? null,
        endsAt: alert.endsAt ?? null,
      } satisfies NormalizedAlert;
    }),
  );
}

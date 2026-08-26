import type { NormalizedAlert } from "./alerts/payload.ts";

/**
 * Prompt framing is a security control, not a convenience.
 *
 * The orchestrator passes IDENTIFIERS ONLY — rule UID, fingerprint, org. The
 * agent looks up the alert's labels, annotations, values and runbook links
 * itself through the Grafana MCP. Alert text authored by whoever named a
 * Kubernetes object therefore never lands in the model's instruction context.
 * (reference analysis §f step 4: "only the canonical URL is passed — never the title".)
 */

export function healingPrompt(alert: NormalizedAlert): string {
  return [
    "A Grafana alert is firing. Heal it.",
    "",
    `alert_rule_uid: ${alert.ruleUid ?? "unknown"}`,
    `fingerprint: ${alert.fingerprint}`,
    `org_id: ${alert.orgId}`,
    "",
    "Do not assume anything about this alert from its identifiers. Start by",
    "fetching the rule and its current state through the Grafana MCP, then follow",
    "the runbook skill that matches the failure signature you find.",
  ].join("\n");
}

export function postmortemPrompt(alert: NormalizedAlert, healingSessionId: string | null): string {
  return [
    "A Grafana alert has resolved. Write the postmortem.",
    "",
    `alert_rule_uid: ${alert.ruleUid ?? "unknown"}`,
    `fingerprint: ${alert.fingerprint}`,
    `org_id: ${alert.orgId}`,
    healingSessionId
      ? `healing_session_id: ${healingSessionId}`
      : "healing_session_id: none (this alert resolved without a healing session)",
    "",
    "Reconstruct the timeline from Grafana (alert state history, metrics),",
    "the Kubernetes event log, and ArgoCD sync history. Follow the",
    "postmortem-template skill and publish the page to the Notion Postmortems",
    "database.",
  ].join("\n");
}

export function handoffPrompt(windowHours: number): string {
  return [
    `Write the on-call handoff summary for the last ${windowHours} hours.`,
    "",
    "Pull the incident list from Grafana alert state history, then follow the",
    "oncall-handoff skill. Include anything still firing, anything healed but",
    "unexplained, and open follow-ups from recent postmortems.",
  ].join("\n");
}

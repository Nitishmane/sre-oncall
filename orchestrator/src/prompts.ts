import type { NormalizedAlert } from "./alerts/payload.ts";

/**
 * Prompt framing is a security control, not a convenience.
 *
 * The orchestrator passes IDENTIFIERS ONLY — rule UID, fingerprint, org. The
 * agent looks up the alert's labels, annotations, values and runbook links
 * itself through the Grafana MCP. Alert text authored by whoever named a
 * Kubernetes object therefore never lands in the model's instruction context.
 * (reference analysis §f step 4: "only the canonical URL is passed — never the title".)
 *
 * The postmortem prompt also frames a handful of orchestrator-recorded
 * timestamps (see `PostmortemFacts`). That is not a weakening of the rule
 * above: a timestamp the orchestrator itself stamped, or a session id it
 * itself minted, cannot carry an instruction the way a label or log line can
 * — there is no free text in it for an attacker to have shaped. What makes
 * the cut is provenance, not size: still nothing sourced from an alert's
 * labels, annotations, or any cluster object's name goes in here.
 */

export function healingPrompt(alert: NormalizedAlert, deployRepo?: string): string {
  return [
    "A Grafana alert is firing. Heal it.",
    "",
    `alert_rule_uid: ${alert.ruleUid ?? "unknown"}`,
    `fingerprint: ${alert.fingerprint}`,
    `org_id: ${alert.orgId}`,
    ...(deployRepo === undefined ? [] : [`deploy_repo: ${deployRepo}`]),
    "",
    "Do not assume anything about this alert from its identifiers. Start by",
    "fetching the rule and its current state through the Grafana MCP, then follow",
    "the runbook skill that matches the failure signature you find.",
    ...(deployRepo === undefined
      ? []
      : [
          "",
          "This platform is deployed by ArgoCD from `deploy_repo` above, so a bad",
          "release is a commit and the fix is a pull request against it. Do not",
          "change the cluster directly to undo a release: open the revert PR and",
          "post it for review.",
        ]),
  ].join("\n");
}

/** The orchestrator-known facts the postmortem prompt frames alongside the alert identifiers. */
export interface PostmortemFacts {
  healingSessionId: string | null;
  /** Epoch ms the orchestrator's own webhook handler first recorded this fingerprint. */
  firstSeenAt: number;
  /** Copied from the alert's own `startsAt`/`endsAt` at delivery time — not re-derived. */
  incidentStartedAt: string | null;
  incidentResolvedAt: string | null;
  /** Epoch ms the healing session above was started. Null only if there was none. */
  healingStartedAt: number | null;
}

export function postmortemPrompt(alert: NormalizedAlert, facts: PostmortemFacts): string {
  return [
    "A Grafana alert has resolved. Write the postmortem.",
    "",
    `alert_rule_uid: ${alert.ruleUid ?? "unknown"}`,
    `fingerprint: ${alert.fingerprint}`,
    `org_id: ${alert.orgId}`,
    facts.healingSessionId
      ? `healing_session_id: ${facts.healingSessionId}`
      : "healing_session_id: none (this alert resolved without a healing session)",
    "",
    // These four are plain timestamps and a session id lifted from the
    // orchestrator's own incident record — not attacker-reachable text, so
    // framing them here does not reopen the injection defense above. They
    // exist because Grafana's alert *history* for an already-resolved
    // fingerprint may have aged out or never been enabled as annotations,
    // while these were captured the moment the webhook and the healing
    // session actually fired. Prefer Grafana's own history when it agrees;
    // when it doesn't, or has nothing, these are the fallback.
    `incident_first_seen_at: ${new Date(facts.firstSeenAt).toISOString()}`,
    `incident_started_at: ${facts.incidentStartedAt ?? "unknown"}`,
    `incident_resolved_at: ${facts.incidentResolvedAt ?? "unknown"}`,
    facts.healingStartedAt !== null
      ? `healing_started_at: ${new Date(facts.healingStartedAt).toISOString()}`
      : "healing_started_at: unknown",
    "",
    "healing_started_at has no Grafana equivalent — it is when this platform's",
    "own healing session began, not an alert-lifecycle timestamp. Grafana,",
    "Kubernetes, and ArgoCD have no record of it.",
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

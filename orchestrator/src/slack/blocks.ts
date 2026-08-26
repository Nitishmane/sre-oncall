import type { KnownBlock } from "@slack/types";
import type { PendingApproval } from "./translator.ts";

/**
 * Block Kit payloads. The approval prompt is the human gate that every
 * remediation passes through, so it has to show exactly what will happen —
 * the tool, the server it runs against, and the full arguments.
 */

export interface ApprovalRef {
  sessionId: string;
  threadId: string;
  toolCallId: string;
}

/** Button `value` payload. Slack caps this at 2000 characters; ids are short. */
export function encodeRef(ref: ApprovalRef): string {
  return JSON.stringify(ref);
}

export function decodeRef(value: string | undefined): ApprovalRef | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sessionId, threadId, toolCallId } = parsed as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof threadId !== "string" || typeof toolCallId !== "string") {
      return null;
    }
    return { sessionId, threadId, toolCallId };
  } catch {
    return null;
  }
}

export const APPROVE_ACTION_ID = "sre_oncall_approve";
export const DENY_ACTION_ID = "sre_oncall_deny";

export function approvalBlocks(approval: PendingApproval, restricted: boolean): KnownBlock[] {
  const ref = encodeRef(approval);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed* — the agent wants to run \`${approval.toolLabel}\`.`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + approval.arguments + "```" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: APPROVE_ACTION_ID,
          value: ref,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: DENY_ACTION_ID,
          value: ref,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: restricted
            ? "Only designated approvers can act on this."
            : "⚠️ Any workspace member can approve this. Set `SLACK_APPROVER_IDS` to restrict.",
        },
      ],
    },
  ];
}

export function decidedBlocks(
  approval: PendingApproval,
  decision: "approved" | "denied",
  userId: string,
): KnownBlock[] {
  const icon = decision === "approved" ? "✅" : "🚫";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${icon} \`${approval.toolLabel}\` was *${decision}* by <@${userId}>.`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + approval.arguments + "```" },
    },
  ];
}

export function incidentBlocks(params: {
  ruleName: string;
  fingerprint: string;
  kind: "healing" | "postmortem" | "handoff";
}): KnownBlock[] {
  const heading =
    params.kind === "healing"
      ? `🔴 *${params.ruleName}* is firing — investigating.`
      : params.kind === "postmortem"
        ? `📝 *${params.ruleName}* resolved — writing the postmortem.`
        : "📋 Writing the on-call handoff summary.";
  return [
    { type: "section", text: { type: "mrkdwn", text: heading } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `fingerprint \`${params.fingerprint}\`` }],
    },
  ];
}

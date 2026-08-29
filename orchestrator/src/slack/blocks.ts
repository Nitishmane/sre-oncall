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

/**
 * Links found in the agent's reasoning — a pull request it opened, a dashboard
 * it wants you to look at. Slack renders a bare URL as a link already; this is
 * here to pull the important one to the top of the message, because "look at
 * the PR before approving" only works if the PR is visible.
 */
const LINK = /https?:\/\/[^\s<>|)\]]+/g;

function reviewLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const url of text.match(LINK) ?? []) {
    // Trailing punctuation belongs to the sentence, not the URL.
    seen.add(url.replace(/[.,;:]+$/, ""));
  }
  return [...seen].slice(0, 4);
}

export function approvalBlocks(approval: PendingApproval, restricted: boolean): KnownBlock[] {
  const ref = encodeRef(approval);
  const rationale = approval.rationale.trim();
  const links = reviewLinks(`${rationale}\n${approval.arguments}`);
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed* — the agent wants to run \`${approval.toolLabel}\`.`,
      },
    },
  ];

  // The agent's case for the change, in its own words. Without this an approver
  // is being asked to rubber stamp an opaque function call.
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        rationale !== ""
          ? truncate(rationale, MAX_RATIONALE_CHARS)
          : "_The agent gave no reason for this action. Treat that as a reason to deny._",
    },
  });

  if (links.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Review before approving:*\n${links.map((url) => `• <${url}>`).join("\n")}`,
      },
    });
  }

  if (approval.arguments.trim() !== "") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Exact call*\n```" + approval.arguments + "```" },
    });
  }

  blocks.push(...([{
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
  ] as KnownBlock[]));

  return blocks;
}

const MAX_RATIONALE_CHARS = 2400;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
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

/**
 * The original alert message, rewritten once the incident is over.
 *
 * The first message in the channel is the one people scroll back to and the one
 * that shows in search and notifications. Leaving it red forever means the
 * channel reads as though every incident is still burning; the state of the
 * world belongs in the message that announced it, not only in a reply buried
 * under the thread.
 */
export function resolvedIncidentBlocks(params: {
  ruleName: string;
  fingerprint: string;
  resolvedAt: Date;
}): KnownBlock[] {
  const when = params.resolvedAt.toISOString().replace("T", " ").slice(0, 19);
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `🟢 *${params.ruleName}* — resolved.` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `fingerprint \`${params.fingerprint}\` · resolved ${when} UTC · details in thread`,
        },
      ],
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

/**
 * The agent has stopped to ask something.
 *
 * Deliberately not buttons-only: the options the agent offers are suggestions,
 * not an exhaustive list, and a question worth asking usually has an answer
 * worth typing. The context line says so, because an unanswered question is a
 * thread that waits forever.
 */
export function questionBlocks(question: { question: string; options: string[] }): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*The agent needs an answer*\n${question.question}` },
    },
  ];
  if (question.options.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Suggested: ${question.options.map((o) => `\`${o}\``).join(" · ")}` }],
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Reply in this thread to answer." }],
  });
  return blocks;
}

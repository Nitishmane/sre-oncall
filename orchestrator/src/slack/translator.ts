import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

/**
 * Turns a TrueForge event stream into the handful of things a Slack surface
 * needs to do. Kept free of Slack SDK types so the interesting logic — what
 * counts as progress, what an approval request actually says, when a session is
 * finished — is testable without a workspace.
 */

export interface PendingApproval {
  sessionId: string;
  /** Harness thread that owns the paused tool call. */
  threadId: string;
  toolCallId: string;
  /** `serverName.toolName`, e.g. `argocd.rollback_application`. */
  toolLabel: string;
  /** Pretty-printed arguments, truncated for a Slack message. */
  arguments: string;
}

export type SurfaceAction =
  /** Replace the in-place status line ("Investigating…", "Checking ArgoCD…"). */
  | { kind: "status"; text: string }
  /** Post a durable message into the thread. */
  | { kind: "message"; text: string }
  /** Post an approval prompt with Approve/Deny buttons. */
  | { kind: "approval"; approval: PendingApproval }
  /** The turn ended; `ok` is false for error or cancellation. */
  | { kind: "done"; ok: boolean; detail: string | null };

const MAX_ARGUMENT_CHARS = 600;

function textOf(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TrueForgeApi.ChatCompletionContentPartText => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolLabel(call: TrueForgeApi.ToolCall): string {
  const info = call.toolInfo;
  if (info.type === "mcp") return `${info.serverName}.${info.name}`;
  return call.function.name;
}

/** Pretty-print tool arguments, which arrive as a JSON string of unknown shape. */
function formatArguments(raw: string): string {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Leave it as-is: a tool that sent malformed JSON is worth seeing verbatim.
  }
  return pretty.length > MAX_ARGUMENT_CHARS
    ? `${pretty.slice(0, MAX_ARGUMENT_CHARS)}\n… (${pretty.length - MAX_ARGUMENT_CHARS} more characters)`
    : pretty;
}

export function createTranslator(sessionId: string) {
  /** Tool calls seen so far, so an approval request can say what it is approving. */
  const toolCalls = new Map<string, TrueForgeApi.ToolCall>();
  /** The last assistant text, used when a finished turn carries no output. */
  let lastText = "";
  /** Approvals already shown, so a pause is not prompted for twice. */
  const prompted = new Set<string>();

  function approvalFor(ref: TrueForgeApi.ToolCallRef, threadId: string): SurfaceAction | null {
    if (prompted.has(ref.id)) return null;
    prompted.add(ref.id);
    const call = toolCalls.get(ref.id);
    return {
      kind: "approval",
      approval: {
        sessionId,
        threadId,
        toolCallId: ref.id,
        toolLabel: call ? toolLabel(call) : "unknown tool",
        arguments: call ? formatArguments(call.function.arguments) : "(arguments unavailable)",
      },
    };
  }

  function handle(event: TrueForgeApi.TurnStreamingEvent): SurfaceAction[] {
    switch (event.type) {
      case "model.message": {
        const actions: SurfaceAction[] = [];
        const text = textOf(event.content).trim();
        if (text !== "") lastText = text;

        for (const call of event.toolCalls ?? []) {
          toolCalls.set(call.id, call);
        }
        const [first] = event.toolCalls ?? [];
        if (first) {
          actions.push({ kind: "status", text: `Running \`${toolLabel(first)}\`…` });
        } else if (text !== "") {
          // A message with no tool calls is the agent thinking out loud.
          actions.push({ kind: "status", text: firstLine(text) });
        }
        return actions;
      }

      case "tool.approval_required": {
        return event.toolCalls
          .map((ref) => approvalFor(ref, event.threadId))
          .filter((action): action is SurfaceAction => action !== null);
      }

      case "turn.done": {
        const state = event.state;
        if (state.status === "done") {
          // A turn that stops at an approval gate is also reported "done", with
          // the pending gates in `requiredActions`. That is a pause, not the end
          // of the session: prompt for the approvals and keep the thread open.
          const pauses = pendingApprovals(state.requiredActions)
            .flatMap((pending) =>
              pending.toolCalls
                .map((ref) => approvalFor(ref, pending.threadId))
                .filter((action): action is SurfaceAction => action !== null),
            );
          if (state.requiredActions.length > 0) {
            return pauses.length > 0
              ? pauses
              : [{ kind: "status", text: "Waiting on a pending action…" }];
          }

          const finalText = textOf(state.output?.content).trim() || lastText;
          return [
            ...(finalText !== "" ? [{ kind: "message" as const, text: finalText }] : []),
            { kind: "done" as const, ok: true, detail: null },
          ];
        }
        if (state.status === "cancelled") {
          return [{ kind: "done", ok: false, detail: `Session cancelled (${state.reason}).` }];
        }
        return [{ kind: "done", ok: false, detail: errorDetail(state) }];
      }

      default:
        return [];
    }
  }

  return { handle };
}

/** Narrows the mixed `requiredActions` list to the approval gates. */
function pendingApprovals(
  actions: TrueForgeApi.ActionRequiredEvent[],
): TrueForgeApi.ToolApprovalRequiredEvent[] {
  return actions.filter(
    (action): action is TrueForgeApi.ToolApprovalRequiredEvent =>
      action.type === "tool.approval_required",
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.length > 150 ? `${line.slice(0, 150)}…` : line;
}

function errorDetail(state: TrueForgeApi.TurnStateError): string {
  return state.message !== "" ? `Session failed: ${state.message}` : "Session failed.";
}

export type Translator = ReturnType<typeof createTranslator>;

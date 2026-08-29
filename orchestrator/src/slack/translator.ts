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
  /**
   * The agent's own words for *this* action — what it found, what it wants to
   * do, and why it expects that to work. Taken from the `model.message` that
   * requested the tool call. Without it an approver is being asked to rubber
   * stamp an opaque function call.
   */
  rationale: string;
  /**
   * Event id of the `model.message` that requested the call. The turn stream
   * does not replay, so if the follower attached after that message it never
   * saw the tool call; this lets it fetch the detail back rather than render
   * "unknown tool".
   */
  sourceEventId: string | null;
}

/**
 * A question the agent has stopped to ask.
 *
 * `ask_user_question` is a tool, not a special event, so the harness pauses the
 * turn exactly the way it does for an approval — `tool.response_required`
 * alongside `tool.approval_required`, same ids, and the answer goes back as
 * `user.tool_response`. Everything here mirrors PendingApproval for that reason.
 */
export interface PendingQuestion {
  sessionId: string;
  /** Harness thread that owns the paused tool call. */
  threadId: string;
  toolCallId: string;
  /** The question itself, as the agent phrased it. */
  question: string;
  /**
   * Suggested answers, when the agent offered any. Rendered as buttons; an
   * empty list means the answer has to be typed into the thread.
   */
  options: string[];
  /** See PendingApproval.sourceEventId — the stream does not replay. */
  sourceEventId: string | null;
}

export type SurfaceAction =
  /** Replace the in-place status line ("Investigating…", "Checking ArgoCD…"). */
  | { kind: "status"; text: string }
  /** Post a durable message into the thread. */
  | { kind: "message"; text: string }
  /** Post an approval prompt with Approve/Deny buttons. */
  | { kind: "approval"; approval: PendingApproval }
  /** Post a question the agent is waiting on an answer to. */
  | { kind: "question"; question: PendingQuestion }
  /** The turn ended; `ok` is false for error or cancellation. */
  | { kind: "done"; ok: boolean; detail: string | null };

const MAX_ARGUMENT_CHARS = 600;

/** Pause types this surface knows how to put in front of a human. */
const RENDERABLE_PAUSES = new Set(["tool.approval_required", "tool.response_required"]);

/** Label used when the tool call was never seen; the follower tries to resolve it. */
export const UNKNOWN_TOOL = "unknown tool";

function textOf(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TrueForgeApi.ChatCompletionContentPartText => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function toolLabel(call: TrueForgeApi.ToolCall): string {
  const info = call.toolInfo;
  if (info.type === "mcp") return `${info.serverName}.${info.name}`;
  // The harness proxies MCP calls through its own `call_tool`, so the function
  // name alone reads "call_tool" — true, and useless to whoever has to decide.
  // The server and tool being invoked are inside the arguments.
  const proxied = proxiedLabel(call.function.name, call.function.arguments);
  return proxied ?? call.function.name;
}

/** `call_tool({mcp_server, tool_name, …})` -> `server.tool`, or null if it is not that. */
function proxiedLabel(name: string, rawArguments: string): string | null {
  if (name !== "call_tool" && name !== "get_tool_info") return null;
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { mcp_server: server, tool_name: tool } = parsed as Record<string, unknown>;
    if (typeof server !== "string" || typeof tool !== "string") return null;
    return `${server}.${tool}`;
  } catch {
    return null;
  }
}

/** Pretty-print tool arguments, which arrive as a JSON string of unknown shape. */
export function formatArguments(raw: string): string {
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
  /**
   * Tool calls seen so far with the text that introduced them, so an approval
   * request can say both what it is approving and why the agent asked.
   */
  const toolCalls = new Map<string, { call: TrueForgeApi.ToolCall; rationale: string }>();
  /** The last assistant text, used when a finished turn carries no output. */
  let lastText = "";
  /** Approvals already shown, so a pause is not prompted for twice. */
  const prompted = new Set<string>();

  function approvalFor(ref: TrueForgeApi.ToolCallRef, threadId: string): SurfaceAction | null {
    if (prompted.has(ref.id)) return null;
    prompted.add(ref.id);
    const seen = toolCalls.get(ref.id);
    return {
      kind: "approval",
      approval: {
        sessionId,
        threadId,
        toolCallId: ref.id,
        toolLabel: seen ? toolLabel(seen.call) : UNKNOWN_TOOL,
        arguments: seen ? formatArguments(seen.call.function.arguments) : "",
        // Fall back to the last thing the agent said: better a slightly stale
        // explanation than none at all.
        rationale: (seen?.rationale ?? "").trim() || lastText,
        sourceEventId: ref.sourceEventId ?? null,
      },
    };
  }

  /**
   * Reads the question out of the `ask_user_question` call that paused the turn.
   * Shares `prompted` with approvals: both are "this tool call is waiting on a
   * human", and the same call must not be posted twice when it arrives both
   * mid-stream and again in `turn.done`.
   */
  function questionFor(ref: TrueForgeApi.ToolCallRef, threadId: string): SurfaceAction | null {
    if (prompted.has(ref.id)) return null;
    prompted.add(ref.id);
    const seen = toolCalls.get(ref.id);
    const { question, options } = parseQuestion(seen?.call.function.arguments);
    return {
      kind: "question",
      question: {
        sessionId,
        threadId,
        toolCallId: ref.id,
        // Fall back to the agent's last words: a question we cannot read is
        // still a question, and silence would strand the thread.
        question: question || (seen?.rationale ?? "").trim() || lastText || "The agent asked a question.",
        options,
        sourceEventId: ref.sourceEventId ?? null,
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
          toolCalls.set(call.id, { call, rationale: text });
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

      case "tool.response_required": {
        return event.toolCalls
          .map((ref) => questionFor(ref, event.threadId))
          .filter((action): action is SurfaceAction => action !== null);
      }

      case "turn.done": {
        const state = event.state;
        if (state.status === "done") {
          // A turn that stops at an approval gate is also reported "done", with
          // the pending gates in `requiredActions`. That is a pause, not the end
          // of the session: prompt for the approvals and keep the thread open.
          const pauses = [
            ...pendingApprovals(state.requiredActions).flatMap((pending) =>
              pending.toolCalls
                .map((ref) => approvalFor(ref, pending.threadId))
                .filter((action): action is SurfaceAction => action !== null),
            ),
            ...pendingQuestions(state.requiredActions).flatMap((pending) =>
              pending.toolCalls
                .map((ref) => questionFor(ref, pending.threadId))
                .filter((action): action is SurfaceAction => action !== null),
            ),
          ];
          if (state.requiredActions.length > 0) {
            if (pauses.length > 0) return pauses;

            // No new prompt to post. Two very different reasons for that, and
            // conflating them either strands a thread or closes a live one.
            //
            // They can also be true at once — an approval already showing its
            // buttons alongside an `mcp.auth_required` nobody can act on here.
            // Reporting only the first leaves the real blocker invisible behind
            // a spinner that never clears, which is the bug this branch exists
            // to prevent in the first place.
            const blocked = [...new Set(
              state.requiredActions
                .filter((action) => !RENDERABLE_PAUSES.has(action.type))
                .map((action) => action.type),
            )];
            const stillWaiting = state.requiredActions.some(
              (action) => RENDERABLE_PAUSES.has(action.type),
            );

            if (blocked.length === 0) {
              // Already prompted mid-stream; a human is looking at the buttons.
              return [{ kind: "status", text: "Waiting on a pending action…" }];
            }

            const kinds = blocked.join(", ");
            const note: SurfaceAction = {
              kind: "message",
              text: `This session is paused on something I can't show here (${kinds}). ` +
                "Continue it in the TrueForge console.",
            };

            // Something renderable still outstanding means the thread is alive:
            // name the extra blocker, but do not close it out from under a
            // human who is mid-decision.
            return stillWaiting
              ? [note, { kind: "status", text: "Waiting on a pending action…" }]
              : [note, { kind: "done", ok: false, detail: `unrenderable pause: ${kinds}` }];
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

function pendingQuestions(
  actions: TrueForgeApi.ActionRequiredEvent[],
): TrueForgeApi.ToolResponseRequiredEvent[] {
  return actions.filter(
    (action): action is TrueForgeApi.ToolResponseRequiredEvent =>
      action.type === "tool.response_required",
  );
}

/**
 * `ask_user_question` arguments are `{question, options}`. Parsed defensively:
 * a malformed payload must still produce a question a human can answer, because
 * the alternative is a thread that waits forever.
 */
function parseQuestion(rawArguments: string | undefined): { question: string; options: string[] } {
  if (rawArguments === undefined) return { question: "", options: [] };
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (typeof parsed !== "object" || parsed === null) return { question: "", options: [] };
    const { question, options } = parsed as Record<string, unknown>;
    return {
      question: typeof question === "string" ? question.trim() : "",
      options: Array.isArray(options)
        ? options.filter((option): option is string => typeof option === "string" && option !== "")
        : [],
    };
  } catch {
    return { question: "", options: [] };
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.length > 150 ? `${line.slice(0, 150)}…` : line;
}

function errorDetail(state: TrueForgeApi.TurnStateError): string {
  return state.message !== "" ? `Session failed: ${state.message}` : "Session failed.";
}

export type Translator = ReturnType<typeof createTranslator>;

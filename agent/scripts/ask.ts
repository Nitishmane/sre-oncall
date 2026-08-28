/**
 * Talk to one of this project's agents from the terminal.
 *
 *   npm run ask -- automation-engineer "Call harness_selftest with 'hello'" --approve
 *   npm run ask -- sre-oncall "What is the demo service doing right now?"
 *
 * Exists because the two other ways in are awkward for a quick check: the Slack
 * and console surfaces need their own wiring up, and the harness UI cannot be
 * scripted or pasted into a commit message. This prints the tool calls, the
 * tool results and the model's text as they stream.
 *
 * Approval gates pause the turn. By default that is where this stops and tells
 * you what it was asked to approve — the gate is the point, and a script that
 * silently approves everything is not a demonstration of one. Pass `--approve`
 * to allow the pending call and resume, which is what you want when the thing
 * you are testing is the tool on the far side of the gate.
 *
 * Note the harness does not hand MCP tools to the model directly: it wraps them
 * behind system tools (`list_tools`, `get_tool_info`, `call_tool`). So every
 * approval names `call_tool`, and the tool a human actually cares about is in
 * its arguments. This unwraps that, because "approve call_tool?" is not a
 * question anyone can answer.
 */
import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

const baseUrl = process.env["TRUEFORGE_API_URL"] ?? "http://localhost:8790";
const token = process.env["TRUEFORGE_TOKEN"];
const client = new TrueForge({ baseUrl, ...(token ? { token } : {}) });

const args = process.argv.slice(2);
const autoApprove = args.includes("--approve");
const [agentName, prompt] = args.filter((arg) => arg !== "--approve");

if (agentName === undefined || prompt === undefined) {
  console.error('usage: npm run ask -- <agent> "<prompt>" [--approve]');
  process.exit(2);
}

/** An approval the harness is waiting on, recovered from the event stream. */
type Pending = {
  threadId: string;
  toolCallId: string;
  /** Model message that asked for the call — needed to name it after the turn. */
  sourceEventId: string;
  label: string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TrueForgeApi.ChatCompletionContentPartText => part?.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncate(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Renders a call the way a human reads it. `call_tool` is the harness's own
 * wrapper, so unwrap it to the MCP server and tool it is really invoking.
 */
function describeCall(call: TrueForgeApi.ToolCall): string {
  const name = call.function.name;
  if (name !== "call_tool") return `${name}(${truncate(call.function.arguments, 160)})`;
  try {
    const parsed = JSON.parse(call.function.arguments) as {
      mcp_server?: string;
      tool_name?: string;
      input?: unknown;
    };
    return `${parsed.mcp_server}/${parsed.tool_name}(${truncate(parsed.input, 160)})`;
  } catch {
    return `call_tool(${truncate(call.function.arguments, 160)})`;
  }
}

async function runTurn(
  sessionId: string,
  input: TrueForgeApi.TurnInputItem[],
  label: string,
): Promise<Pending | null> {
  const turn = await client.sessions.createTurn(sessionId, { input });
  console.log(`\n── turn ${turn.data.id} (${label})`);

  // Built as the stream runs so an approval can name the call it belongs to
  // without a second round trip — the approval event carries only ids.
  const callsByEvent = new Map<string, TrueForgeApi.ToolCall[]>();
  let pending: Pending | null = null;
  const stream = await client.sessions.subscribeToTurn(sessionId, turn.data.id);

  for await (const raw of stream) {
    // Older harness builds wrap the event; newer ones send it bare.
    const event = ((raw as { event?: unknown }).event ?? raw) as Record<string, unknown>;
    const type = String(event["type"] ?? "");

    if (type === "model.message") {
      const calls = (event["toolCalls"] ?? event["tool_calls"] ?? []) as TrueForgeApi.ToolCall[];
      if (calls.length > 0) callsByEvent.set(String(event["id"]), calls);
      for (const call of calls) console.log(`  → ${describeCall(call)}`);
      const text = textOf(event["content"]).trim();
      if (text !== "") console.log(`\n${text}\n`);
      continue;
    }

    // Must precede the generic `tool.` branch: the approval arrives as
    // `tool.approval_required`, so matching the prefix first swallows it and
    // the run ends looking like it merely stopped.
    if (type.includes("approval")) {
      // The SDK stream normalises to camelCase; the REST events list returns
      // snake_case. Both spellings reach this line depending on which fed it,
      // and reading only one silently yields an empty id — which is how this
      // gate spent a while reporting "an unidentified tool".
      const calls = (event["toolCalls"] ?? event["tool_calls"] ?? []) as {
        id?: string;
        sourceEventId?: string;
        source_event_id?: string;
      }[];
      const first = calls[0] ?? {};
      // Only the ids are known here. Naming the tool has to wait until the
      // stream closes: the model message that requested it is not written until
      // the turn finishes, so any lookup from inside this loop always misses.
      pending = {
        threadId: String(event["thread_id"] ?? event["threadId"] ?? "main"),
        toolCallId: String(first.id ?? ""),
        sourceEventId: String(first.sourceEventId ?? first.source_event_id ?? ""),
        label: "",
      };
      continue;
    }

    if (type.startsWith("tool.")) {
      const body = event["content"] ?? event["output"] ?? event["result"];
      if (body !== undefined) console.log(`  ← ${truncate(body, 700)}`);
      continue;
    }

    if (type === "turn.failed") console.log(`  [${type}] ${truncate(event["state"], 300)}`);
  }

  if (pending !== null) {
    const streamed = callsByEvent.get(pending.sourceEventId);
    const match =
      streamed?.find((call) => call.id === pending.toolCallId) ??
      streamed?.[0] ??
      (await lookupCall(sessionId, pending.sourceEventId, pending.toolCallId));
    pending.label = match ? describeCall(match) : "an unidentified tool";
    console.log(`  ⏸  APPROVAL GATE — ${pending.label}`);
  }
  return pending;
}

/** Session events, newest first. The stream is lossy; this list is not. */
async function sessionEvents(sessionId: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: unknown[] };
  return (body.data ?? []).map(
    (item) => ((item as { event?: unknown }).event ?? item) as Record<string, unknown>,
  );
}

/**
 * The call an approval is asking about.
 *
 * The approval event carries only ids, and `model.message` never reaches a turn
 * subscriber — the stream delivers tool results but not the model turns that
 * requested them. So the name has to be read back from the events list, or
 * every gate reads "an unidentified tool", which is worse than useless on a
 * prompt asking a human to approve something.
 *
 * Retried because the two race: the approval reaches a subscriber before the
 * message that caused it has been written, so the first read reliably misses.
 */
async function lookupCall(
  sessionId: string,
  sourceEventId: string,
  toolCallId: string,
): Promise<TrueForgeApi.ToolCall | undefined> {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const event of await sessionEvents(sessionId)) {
      if (event["type"] !== "model.message" || String(event["id"]) !== sourceEventId) continue;
      const calls = (event["toolCalls"] ?? event["tool_calls"] ?? []) as TrueForgeApi.ToolCall[];
      return calls.find((call) => call.id === toolCallId) ?? calls[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/**
 * The last thing the model said, read back over REST.
 *
 * The turn stream can close before the closing message reaches a subscriber,
 * which makes a successful run look like it produced nothing at all. The events
 * list is authoritative, so ask it rather than trusting the stream to be
 * complete.
 */
async function finalAnswer(sessionId: string): Promise<string> {
  // The list comes back newest-first, so the first text-bearing message wins.
  for (const event of await sessionEvents(sessionId)) {
    if (event["type"] !== "model.message") continue;
    const calls = (event["toolCalls"] ?? event["tool_calls"] ?? []) as unknown[];
    if (calls.length > 0) continue;
    const text = textOf(event["content"]).trim();
    if (text !== "") return text;
  }
  return "";
}

const session = await client.sessions.create({ agent: { name: agentName } });
const sessionId = session.data.id;
console.log(`agent ${agentName} · session ${sessionId}`);

let pending = await runTurn(sessionId, [{ type: "user.message", content: prompt }], "initial");

while (pending !== null) {
  if (!autoApprove) {
    console.log(
      `\nPaused at an approval gate for ${pending.label}.\n` +
        "Re-run with --approve to allow it, or approve it in Slack or the console.",
    );
    break;
  }
  console.log(`\n✓ approving ${pending.label}`);
  pending = await runTurn(
    sessionId,
    [{
      type: "user.tool_approval",
      threadId: pending.threadId,
      toolCallId: pending.toolCallId,
      approval: { status: "allow" },
    }],
    "resumed",
  );
}

if (pending === null) {
  const answer = await finalAnswer(sessionId);
  if (answer !== "") console.log(`\n${answer}`);
}
console.log(`\nsession ${sessionId}`);

import type bolt from "@slack/bolt";
import type { Store } from "../store.ts";
import type { PendingApproval, PendingQuestion } from "./translator.ts";
import type { Surface } from "./surface.ts";
import { approvalBlocks, questionBlocks } from "./blocks.ts";

/**
 * A Slack-backed surface for one session's thread.
 *
 * Progress is shown by editing a single status message in place rather than
 * posting a line per step — a long investigation would otherwise bury the
 * thread. The status message is deleted when the session finishes so the thread
 * is left holding only real content.
 */
export interface SlackSurfaceDeps {
  app: bolt.App;
  store: Store;
  channel: string;
  threadTs: string;
  sessionId: string;
  restricted: boolean;
}

export function createSlackSurface(deps: SlackSurfaceDeps): Surface {
  const { app, store, channel, threadTs, sessionId, restricted } = deps;

  async function statusTs(): Promise<string | null> {
    return store.slackSession(sessionId)?.status_ts ?? null;
  }

  return {
    async setStatus(text: string): Promise<void> {
      const existing = await statusTs();
      const body = `_${text}_`;
      if (existing !== null) {
        await app.client.chat.update({ channel, ts: existing, text: body });
        return;
      }
      const posted = await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: body,
      });
      if (typeof posted.ts === "string") {
        store.setStatusMessage(sessionId, posted.ts, Date.now());
      }
    },

    async post(text: string): Promise<void> {
      // Slack rejects messages over 40k; 3000 keeps blocks comfortable too.
      for (const chunk of chunkText(text, 3000)) {
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
    },

    async postApproval(approval: PendingApproval): Promise<string | null> {
      const posted = await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Approval needed: ${approval.toolLabel}`,
        blocks: approvalBlocks(approval, restricted),
      });
      return typeof posted.ts === "string" ? posted.ts : null;
    },

    async postQuestion(question: PendingQuestion): Promise<string | null> {
      const posted = await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `The agent needs an answer: ${question.question}`,
        blocks: questionBlocks(question),
      });
      return typeof posted.ts === "string" ? posted.ts : null;
    },

    async finish(ok: boolean, detail: string | null): Promise<void> {
      const existing = await statusTs();
      if (existing !== null) {
        await app.client.chat.delete({ channel, ts: existing }).catch(() => {
          // A status message someone already deleted is not an error.
        });
      }
      if (!ok && detail !== null) {
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: `⚠️ ${detail}` });
      }
    },
  };
}

/** Splits on paragraph boundaries where possible, hard-splitting only if forced. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length > limit) {
      if (current !== "") { chunks.push(current); current = ""; }
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit));
      }
      continue;
    }
    if (current === "") current = paragraph;
    else if (current.length + paragraph.length + 2 <= limit) current += `\n\n${paragraph}`;
    else { chunks.push(current); current = paragraph; }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

import type { PendingApproval, PendingQuestion, SurfaceAction } from "./translator.ts";

/**
 * Everything the watcher needs from Slack, as an interface — so the watcher can
 * be driven by a fake in tests and by Bolt in production.
 */
export interface Surface {
  /** Creates or replaces the single in-place status line for this session. */
  setStatus(text: string): Promise<void>;
  /** Posts a durable message into the thread. */
  post(text: string): Promise<void>;
  /** Posts the approval prompt; returns the message ts so it can be updated. */
  postApproval(approval: PendingApproval): Promise<string | null>;
  /** Posts a question the agent is waiting on; returns the message ts. */
  postQuestion(question: PendingQuestion): Promise<string | null>;
  /** Clears the status line and marks the session finished. */
  finish(ok: boolean, detail: string | null): Promise<void>;
}

/**
 * Applies translated actions to a surface, one at a time and in order.
 * A slow or failing Slack call must never stall or crash the session watcher,
 * so failures are reported and swallowed.
 */
export async function applyAction(
  surface: Surface,
  action: SurfaceAction,
  onError: (err: unknown, action: SurfaceAction) => void,
): Promise<void> {
  try {
    switch (action.kind) {
      case "status":
        await surface.setStatus(action.text);
        return;
      case "message":
        await surface.post(action.text);
        return;
      case "approval":
        await surface.postApproval(action.approval);
        return;
      case "question":
        await surface.postQuestion(action.question);
        return;
      case "done":
        await surface.finish(action.ok, action.detail);
        return;
    }
  } catch (err) {
    onError(err, action);
  }
}

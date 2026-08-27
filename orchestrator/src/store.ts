import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Incident state, persisted so a restart mid-incident doesn't re-triage
 * everything and so the handoff summary has history to draw on.
 * Uses Node's built-in SQLite — no native module to build.
 */

export interface IncidentRow {
  fingerprint: string;
  rule_uid: string | null;
  rule_name: string;
  org_id: number;
  status: string;
  first_seen_at: number;
  last_seen_at: number;
  started_at: string | null;
  resolved_at: string | null;
  last_triaged_at: number | null;
  healing_session_id: string | null;
  postmortem_session_id: string | null;
}

export interface SlackSessionRow {
  session_id: string;
  channel: string;
  thread_ts: string;
  status_ts: string | null;
  updated_at: number;
}

export interface ApprovalRow {
  id: number;
  session_id: string;
  thread_id: string;
  tool_call_id: string;
  tool_label: string;
  arguments: string;
  channel: string | null;
  message_ts: string | null;
  requested_at: number;
  decided_at: number | null;
  decision: "approved" | "denied" | null;
  decided_by: string | null;
  /** The agent's stated reason for the action, shown to whoever approves it. */
  rationale: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  fingerprint            TEXT PRIMARY KEY,
  rule_uid               TEXT,
  rule_name              TEXT NOT NULL,
  org_id                 INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL,
  first_seen_at          INTEGER NOT NULL,
  last_seen_at           INTEGER NOT NULL,
  started_at             TEXT,
  resolved_at            TEXT,
  last_triaged_at        INTEGER,
  healing_session_id     TEXT,
  postmortem_session_id  TEXT
);
CREATE TABLE IF NOT EXISTS triage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_log_at ON triage_log (at);
CREATE INDEX IF NOT EXISTS incidents_last_seen ON incidents (last_seen_at);

-- Binds a harness session to the Slack thread that displays it, so a follow-up
-- reply resumes the same session rather than starting a new one.
CREATE TABLE IF NOT EXISTS slack_sessions (
  session_id  TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  status_ts   TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_sessions_thread ON slack_sessions (channel, thread_ts);

-- Audit log of every approval gate the agent hit: what it asked to do, who
-- decided, and when. Survives restarts, and is what the /approvals endpoint
-- serves to the console.
CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  tool_call_id  TEXT NOT NULL,
  tool_label    TEXT NOT NULL,
  arguments     TEXT NOT NULL,
  rationale     TEXT NOT NULL DEFAULT '',
  channel       TEXT,
  message_ts    TEXT,
  requested_at  INTEGER NOT NULL,
  decided_at    INTEGER,
  decision      TEXT,
  decided_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_call ON approvals (session_id, tool_call_id);
`;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database
  // written before approvals carried a rationale needs the column adding. The
  // duplicate-column error on an up-to-date database is the expected outcome.
  try {
    db.exec("ALTER TABLE approvals ADD COLUMN rationale TEXT NOT NULL DEFAULT ''");
  } catch {
    // Already present.
  }

  const upsert = db.prepare(`
    INSERT INTO incidents (fingerprint, rule_uid, rule_name, org_id, status,
                           first_seen_at, last_seen_at, started_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      status      = excluded.status,
      last_seen_at = excluded.last_seen_at,
      rule_uid    = COALESCE(excluded.rule_uid, incidents.rule_uid),
      started_at  = COALESCE(incidents.started_at, excluded.started_at),
      resolved_at = excluded.resolved_at
  `);
  const selectOne = db.prepare("SELECT * FROM incidents WHERE fingerprint = ?");
  const markTriaged = db.prepare("UPDATE incidents SET last_triaged_at = ?, healing_session_id = ? WHERE fingerprint = ?");
  const markPostmortem = db.prepare("UPDATE incidents SET postmortem_session_id = ? WHERE fingerprint = ?");
  const insertTriage = db.prepare("INSERT INTO triage_log (fingerprint, at) VALUES (?, ?)");
  const countTriages = db.prepare("SELECT COUNT(*) AS n FROM triage_log WHERE at >= ?");
  const recent = db.prepare("SELECT * FROM incidents WHERE last_seen_at >= ? ORDER BY last_seen_at DESC");

  const bindSlack = db.prepare(`
    INSERT INTO slack_sessions (session_id, channel, thread_ts, status_ts, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      channel = excluded.channel, thread_ts = excluded.thread_ts,
      status_ts = COALESCE(excluded.status_ts, slack_sessions.status_ts),
      updated_at = excluded.updated_at
  `);
  const slackByThread = db.prepare("SELECT * FROM slack_sessions WHERE channel = ? AND thread_ts = ?");
  const slackBySession = db.prepare("SELECT * FROM slack_sessions WHERE session_id = ?");
  const setStatusTs = db.prepare("UPDATE slack_sessions SET status_ts = ?, updated_at = ? WHERE session_id = ?");

  const insertApproval = db.prepare(`
    INSERT INTO approvals (session_id, thread_id, tool_call_id, tool_label, arguments,
                           rationale, channel, message_ts, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, tool_call_id) DO UPDATE SET
      channel = excluded.channel, message_ts = excluded.message_ts,
      -- A re-record after the Slack post must not blank out detail the first
      -- write resolved, but it may fill in detail the first write lacked.
      tool_label = CASE WHEN excluded.tool_label = 'unknown tool'
                        THEN approvals.tool_label ELSE excluded.tool_label END,
      arguments = CASE WHEN excluded.arguments = '' THEN approvals.arguments
                       ELSE excluded.arguments END,
      rationale = CASE WHEN excluded.rationale = '' THEN approvals.rationale
                       ELSE excluded.rationale END
  `);
  const decideApproval = db.prepare(`
    UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?
    WHERE session_id = ? AND tool_call_id = ? AND decision IS NULL
  `);
  const selectApproval = db.prepare("SELECT * FROM approvals WHERE session_id = ? AND tool_call_id = ?");
  const recentApprovals = db.prepare("SELECT * FROM approvals WHERE requested_at >= ? ORDER BY requested_at DESC");

  return {
    db,
    recordSeen(alert: {
      fingerprint: string;
      ruleUid: string | null;
      ruleName: string;
      orgId: number;
      status: string;
      startsAt: string | null;
      endsAt: string | null;
    }, now: number): void {
      upsert.run(
        alert.fingerprint,
        alert.ruleUid,
        alert.ruleName,
        alert.orgId,
        alert.status,
        now,
        now,
        alert.startsAt,
        alert.status === "resolved" ? alert.endsAt : null,
      );
    },
    get(fingerprint: string): IncidentRow | undefined {
      return selectOne.get(fingerprint) as IncidentRow | undefined;
    },
    /**
     * Counts an attempt against the hourly rate limit. Called *before* the
     * harness is asked for a session, so a harness that is down cannot be
     * retried without bound — the limit exists to cap load, and a failed
     * attempt costs the same as a successful one.
     */
    recordTriageAttempt(fingerprint: string, now: number): void {
      insertTriage.run(fingerprint, now);
    },
    /**
     * Marks a triage as having actually started. Only this sets the per-incident
     * cooldown, so a transient failure can be retried on the next delivery
     * rather than being suppressed for an hour.
     */
    recordTriage(fingerprint: string, sessionId: string | null, now: number): void {
      markTriaged.run(now, sessionId, fingerprint);
    },
    recordPostmortem(fingerprint: string, sessionId: string): void {
      markPostmortem.run(sessionId, fingerprint);
    },
    triagesSince(since: number): number {
      const row = countTriages.get(since) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    incidentsSince(since: number): IncidentRow[] {
      return recent.all(since) as unknown as IncidentRow[];
    },

    bindSlackThread(sessionId: string, channel: string, threadTs: string, statusTs: string | null, now: number): void {
      bindSlack.run(sessionId, channel, threadTs, statusTs, now);
    },
    slackSessionForThread(channel: string, threadTs: string): SlackSessionRow | undefined {
      return slackByThread.get(channel, threadTs) as SlackSessionRow | undefined;
    },
    slackSession(sessionId: string): SlackSessionRow | undefined {
      return slackBySession.get(sessionId) as SlackSessionRow | undefined;
    },
    setStatusMessage(sessionId: string, statusTs: string, now: number): void {
      setStatusTs.run(statusTs, now, sessionId);
    },

    recordApprovalRequest(request: {
      sessionId: string; threadId: string; toolCallId: string;
      toolLabel: string; arguments: string; rationale?: string;
      channel: string | null; messageTs: string | null;
    }, now: number): void {
      insertApproval.run(
        request.sessionId, request.threadId, request.toolCallId,
        request.toolLabel, request.arguments, request.rationale ?? "",
        request.channel, request.messageTs, now,
      );
    },
    /** Returns false when the approval was already decided — the guard against double-clicks. */
    recordApprovalDecision(
      sessionId: string, toolCallId: string,
      decision: "approved" | "denied", decidedBy: string, now: number,
    ): boolean {
      const result = decideApproval.run(decision, decidedBy, now, sessionId, toolCallId);
      return result.changes > 0;
    },
    approval(sessionId: string, toolCallId: string): ApprovalRow | undefined {
      return selectApproval.get(sessionId, toolCallId) as ApprovalRow | undefined;
    },
    approvalsSince(since: number): ApprovalRow[] {
      return recentApprovals.all(since) as unknown as ApprovalRow[];
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;

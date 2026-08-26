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
`;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

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
    /** Records a triage for both the per-incident cooldown and the hourly rate limit. */
    recordTriage(fingerprint: string, sessionId: string | null, now: number): void {
      markTriaged.run(now, sessionId, fingerprint);
      insertTriage.run(fingerprint, now);
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
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;

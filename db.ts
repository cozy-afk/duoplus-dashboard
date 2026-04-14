/**
 * Persistence layer — Turso / libsql client.
 *
 * When TURSO_DATABASE_URL is set the app connects to the cloud database
 * (shared by all teammates). Without it, falls back to a local SQLite file
 * so individual developers can run the app without credentials.
 *
 * All repo methods are async. Callers must await every call.
 *
 * Boot: call `await initDb()` once before using any repo (server.ts does this).
 */

import { createClient, type Client, type Row } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LOCAL_PATH = process.env.DB_PATH || "./data/dashboard.sqlite";

const dbUrl = TURSO_URL ?? `file:${LOCAL_PATH}`;

// For local file URLs, ensure the directory exists.
if (!TURSO_URL) {
  mkdirSync(dirname(LOCAL_PATH), { recursive: true });
}

export const client: Client = createClient({
  url: dbUrl,
  authToken: TURSO_TOKEN,
});

// ---------------------------------------------------------------------------
// Row helper — libsql Row objects look like arrays with named props.
// Casting through unknown gives us plain TS types.
// ---------------------------------------------------------------------------
function row<T>(r: Row): T {
  return r as unknown as T;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','threads','tiktok')),
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(device_id, platform, username)
);

CREATE TABLE IF NOT EXISTS quotas (
  platform TEXT PRIMARY KEY CHECK (platform IN ('instagram','threads','tiktok')),
  session_min_min INTEGER NOT NULL DEFAULT 10,
  session_max_min INTEGER NOT NULL DEFAULT 15,
  feed_scrolls_min INTEGER NOT NULL DEFAULT 6,
  feed_scrolls_max INTEGER NOT NULL DEFAULT 10,
  reels_min INTEGER NOT NULL DEFAULT 4,
  reels_max INTEGER NOT NULL DEFAULT 7,
  stories_min INTEGER NOT NULL DEFAULT 2,
  stories_max INTEGER NOT NULL DEFAULT 4,
  explore_scrolls_min INTEGER NOT NULL DEFAULT 3,
  explore_scrolls_max INTEGER NOT NULL DEFAULT 6,
  likes_per_session INTEGER NOT NULL DEFAULT 3,
  comments_per_session INTEGER NOT NULL DEFAULT 0,
  follows_per_session INTEGER NOT NULL DEFAULT 0,
  unfollows_per_session INTEGER NOT NULL DEFAULT 0,
  dms_per_session INTEGER NOT NULL DEFAULT 0,
  shares_per_session INTEGER NOT NULL DEFAULT 0,
  profile_visits_per_session INTEGER NOT NULL DEFAULT 1,
  daily_follow_cap INTEGER NOT NULL DEFAULT 20,
  daily_action_cap INTEGER NOT NULL DEFAULT 150,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS session_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  followers_before INTEGER,
  followers_after INTEGER,
  following_before INTEGER,
  following_after INTEGER,
  actions_planned_json TEXT,
  actions_performed_json TEXT,
  duoplus_task_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS session_runs_account_idx ON session_runs(account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS growth_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  followers INTEGER,
  following INTEGER,
  posts INTEGER
);
CREATE INDEX IF NOT EXISTS growth_account_ts_idx ON growth_snapshots(account_id, ts DESC);

CREATE TABLE IF NOT EXISTS follow_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','threads','tiktok')),
  handle TEXT NOT NULL,
  min_followers INTEGER DEFAULT 0,
  max_followers INTEGER,
  min_posts INTEGER DEFAULT 0,
  max_following INTEGER,
  require_avatar INTEGER DEFAULT 1,
  skip_private INTEGER DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','threads','tiktok')),
  caption TEXT,
  media_urls_json TEXT,
  scheduled_at INTEGER,
  posted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','posting','posted','failed','canceled')),
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS posts_queue_idx ON scheduled_posts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS unknown_screens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  platform TEXT,
  context TEXT,
  focus TEXT,
  xml_head TEXT,
  recovered INTEGER DEFAULT 0,
  recovery_action TEXT,
  screenshot_path TEXT,
  analysis TEXT,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS unknown_screens_ts_idx ON unknown_screens(ts DESC);

CREATE TABLE IF NOT EXISTS login_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','threads','tiktok')),
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  totp_secret TEXT,
  assigned_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','assigned','logging-in','success','failed')),
  error TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS login_queue_status_idx ON login_queue(status, created_at);

CREATE TABLE IF NOT EXISTS batch_runs (
  run_id TEXT PRIMARY KEY,
  automation TEXT NOT NULL,
  device_ids_json TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','interrupted'))
);
CREATE INDEX IF NOT EXISTS batch_runs_status_idx ON batch_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS batch_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS batch_run_logs_run_idx ON batch_run_logs(run_id, id);

-- Structured event log. Every meaningful state transition (stall detected,
-- account flagged, pool rotation, login failure, etc.) writes one row here
-- with a stable code so the UI can filter "show me every verify.required
-- event for @foo in the last 24h" without grepping batch_run_logs.
CREATE TABLE IF NOT EXISTS event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  msg TEXT NOT NULL,
  run_id TEXT,
  device_id TEXT,
  platform TEXT,
  username TEXT,
  account_id INTEGER,
  phase TEXT,
  attempt INTEGER,
  json TEXT,
  stack TEXT
);
CREATE INDEX IF NOT EXISTS event_logs_ts_idx ON event_logs(ts DESC);
CREATE INDEX IF NOT EXISTS event_logs_device_ts_idx ON event_logs(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS event_logs_username_ts_idx ON event_logs(username, ts DESC);
CREATE INDEX IF NOT EXISTS event_logs_code_ts_idx ON event_logs(code, ts DESC);

-- Operator-curated patterns for screen recovery. When the runtime hits an
-- unknown screen, it walks this table BEFORE falling into the generic
-- dismiss/back/relaunch ladder. Each pattern is a list of XML match rules
-- (AND-joined) plus a single recovery action. Operators promote rows here
-- from the unknown_screens table via the Screen Log "Approve" UI.
--
-- signature_json shape:
--   [{"type":"text"|"desc"|"resource-id"|"focus","contains":"<substring>"}, ...]
-- recovery_action enum:
--   tap_text | tap_desc | tap_resource_id | press_back | swipe_down | relaunch
-- recovery_arg: the substring/value the action needs (null for press_back/swipe_down)
CREATE TABLE IF NOT EXISTS screen_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT,                                 -- null = any platform
  enabled INTEGER NOT NULL DEFAULT 1,
  signature_json TEXT NOT NULL,
  recovery_action TEXT NOT NULL,
  recovery_arg TEXT,
  times_matched INTEGER NOT NULL DEFAULT 0,
  times_recovered INTEGER NOT NULL DEFAULT 0,
  last_matched_at INTEGER,
  source_unknown_id INTEGER REFERENCES unknown_screens(id) ON DELETE SET NULL,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS screen_patterns_enabled_idx ON screen_patterns(enabled, platform);

-- Operator attention queue. Created whenever a device+platform slot needs
-- a human — e.g. TikTok is installed but nobody is logged in, or an
-- account hit verification. Upserted on (device_id, platform), so re-hits
-- just bump last_seen_at instead of flooding the table. Resolved rows stay
-- around for audit (set resolved_at).
CREATE TABLE IF NOT EXISTS account_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','threads','tiktok')),
  reason TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  hit_count INTEGER NOT NULL DEFAULT 1
);
-- Partial unique index: at most ONE pending (resolved_at IS NULL) row per
-- (device_id, platform). Resolved rows aren't indexed, so history accumulates
-- without constraint violations when the same slot is flagged again later.
CREATE UNIQUE INDEX IF NOT EXISTS account_requests_pending_unique
  ON account_requests(device_id, platform) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS account_requests_pending_idx
  ON account_requests(resolved_at, last_seen_at DESC);
`;

// ---------------------------------------------------------------------------
// Boot: run schema + seed quotas + mark stale runs interrupted.
// Call once at startup before any repo method.
// ---------------------------------------------------------------------------
export async function initDb(): Promise<void> {
  // libsql execute supports multi-statement strings separated by semicolons.
  await client.executeMultiple(SCHEMA_SQL);

  // Seed defaults + clear stale 'running' rows atomically so a crash mid-init
  // can't leave the DB half-seeded. If any step fails, the whole batch rolls
  // back and initDb() can be retried idempotently on the next boot.
  const tx = await client.transaction("write");
  try {
    for (const p of ["instagram", "threads", "tiktok"]) {
      await tx.execute({
        sql: "INSERT OR IGNORE INTO quotas (platform) VALUES (?);",
        args: [p],
      });
    }
    await tx.execute(
      "UPDATE batch_runs SET status='interrupted', ended_at=unixepoch() WHERE status='running';",
    );
    await tx.execute(
      "UPDATE session_runs SET status='interrupted', ended_at=unixepoch(), error=COALESCE(error,'process restarted') WHERE status='running';",
    );
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface Account {
  id: number;
  device_id: string;
  platform: "instagram" | "threads" | "tiktok";
  username: string;
  status: string;
  notes: string | null;
  last_run_at: number | null;
  created_at: number;
}

export interface Quota {
  platform: "instagram" | "threads" | "tiktok";
  session_min_min: number;
  session_max_min: number;
  feed_scrolls_min: number;
  feed_scrolls_max: number;
  reels_min: number;
  reels_max: number;
  stories_min: number;
  stories_max: number;
  explore_scrolls_min: number;
  explore_scrolls_max: number;
  likes_per_session: number;
  comments_per_session: number;
  follows_per_session: number;
  unfollows_per_session: number;
  dms_per_session: number;
  shares_per_session: number;
  profile_visits_per_session: number;
  daily_follow_cap: number;
  daily_action_cap: number;
  updated_at: number;
}

export interface SessionRun {
  id: number;
  account_id: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  followers_before: number | null;
  followers_after: number | null;
  following_before: number | null;
  following_after: number | null;
  actions_planned_json: string | null;
  duoplus_task_id: string | null;
  error: string | null;
}

export interface FollowTarget {
  id: number;
  platform: "instagram" | "threads" | "tiktok";
  handle: string;
  min_followers: number;
  max_followers: number | null;
  min_posts: number;
  max_following: number | null;
  require_avatar: number;
  skip_private: number;
  enabled: number;
  created_at: number;
  notes: string | null;
}

export interface ScheduledPost {
  id: number;
  account_id: number | null;
  platform: "instagram" | "threads" | "tiktok";
  caption: string | null;
  media_urls_json: string | null;
  scheduled_at: number | null;
  posted_at: number | null;
  status: "queued" | "posting" | "posted" | "failed" | "canceled";
  error: string | null;
  created_at: number;
}

export interface BatchRun {
  run_id: string;
  automation: string;
  device_ids_json: string;
  started_at: number;
  ended_at: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
}

export interface BatchRunLog {
  id: number;
  run_id: string;
  ts: number;
  level: string;
  msg: string;
}

export interface UnknownScreen {
  id: number;
  device_id: string;
  platform: string | null;
  context: string | null;
  focus: string | null;
  xml_head: string | null;
  recovered: number;
  recovery_action: string | null;
  ts: number;
  screenshot_path: string | null;
  analysis: string | null;
}

export interface LoginQueueRow {
  id: number;
  platform: "instagram" | "threads" | "tiktok";
  username: string;
  password: string;
  totp_secret: string | null;
  assigned_device_id: string | null;
  status: "pending" | "assigned" | "logging-in" | "success" | "failed";
  error: string | null;
  account_id: number | null;
  created_at: number;
  finished_at: number | null;
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

// Whitelist of mutable columns per update() call-site. Column names are
// interpolated into SQL (they can't be parameterized), so we must prevent
// an attacker-controlled patch key from injecting SQL.
const UPDATABLE_COLUMNS = {
  accounts: new Set(["status", "notes", "username"]),
  quotas: new Set([
    "session_min_min",
    "session_max_min",
    "feed_scrolls_min",
    "feed_scrolls_max",
    "reels_min",
    "reels_max",
    "stories_min",
    "stories_max",
    "explore_scrolls_min",
    "explore_scrolls_max",
    "likes_per_session",
    "comments_per_session",
    "follows_per_session",
    "unfollows_per_session",
    "dms_per_session",
    "shares_per_session",
    "profile_visits_per_session",
    "daily_follow_cap",
    "daily_action_cap",
  ]),
  session_runs: new Set([
    "followers_before",
    "followers_after",
    "following_before",
    "following_after",
    "duoplus_task_id",
  ]),
  follow_targets: new Set([
    "platform",
    "handle",
    "min_followers",
    "max_followers",
    "min_posts",
    "max_following",
    "require_avatar",
    "skip_private",
    "enabled",
    "notes",
  ]),
} as const;

function safeFields(table: keyof typeof UPDATABLE_COLUMNS, patch: Record<string, unknown>): string[] {
  const allow = UPDATABLE_COLUMNS[table];
  const keys = Object.keys(patch);
  for (const k of keys) {
    if (!allow.has(k)) {
      throw new Error(`refusing to UPDATE ${table}: disallowed column "${k}"`);
    }
  }
  return keys;
}

export const accountsRepo = {
  async list(): Promise<Account[]> {
    const r = await client.execute("SELECT * FROM accounts ORDER BY platform, username;");
    return r.rows.map(row<Account>);
  },
  async byDevice(device_id: string): Promise<Account[]> {
    const r = await client.execute({
      sql: "SELECT * FROM accounts WHERE device_id=? ORDER BY platform;",
      args: [device_id],
    });
    return r.rows.map(row<Account>);
  },
  async byDevicePlatform(device_id: string, platform: Account["platform"]): Promise<Account[]> {
    const r = await client.execute({
      sql: "SELECT * FROM accounts WHERE device_id=? AND platform=? ORDER BY username;",
      args: [device_id, platform],
    });
    return r.rows.map(row<Account>);
  },
  async findByUsername(
    platform: Account["platform"],
    username: string,
  ): Promise<Account | null> {
    const r = await client.execute({
      sql: "SELECT * FROM accounts WHERE platform=? AND username=? LIMIT 1;",
      args: [platform, username],
    });
    return r.rows[0] ? row<Account>(r.rows[0]) : null;
  },
  async byId(id: number): Promise<Account | null> {
    const r = await client.execute({ sql: "SELECT * FROM accounts WHERE id=?;", args: [id] });
    return r.rows[0] ? row<Account>(r.rows[0]) : null;
  },
  async create(
    data: Omit<Account, "id" | "created_at" | "last_run_at" | "status"> & { status?: string },
  ): Promise<number> {
    const r = await client.execute({
      sql: `INSERT INTO accounts (device_id, platform, username, status, notes)
              VALUES (?, ?, ?, COALESCE(?, 'active'), ?);`,
      args: [data.device_id, data.platform, data.username, data.status ?? null, data.notes ?? null],
    });
    return Number(r.lastInsertRowid);
  },
  async update(
    id: number,
    patch: Partial<Pick<Account, "status" | "notes" | "username">>,
  ): Promise<void> {
    const fields = safeFields("accounts", patch);
    if (!fields.length) return;
    await client.execute({
      sql: `UPDATE accounts SET ${fields.map((f) => `${f}=?`).join(", ")} WHERE id=?;`,
      args: [...fields.map((f) => (patch as Record<string, unknown>)[f] as string | null), id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM accounts WHERE id=?;", args: [id] });
  },
  async touchLastRun(id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE accounts SET last_run_at=unixepoch() WHERE id=?;",
      args: [id],
    });
  },
};

export const quotasRepo = {
  async get(platform: Quota["platform"]): Promise<Quota> {
    const r = await client.execute({
      sql: "SELECT * FROM quotas WHERE platform=?;",
      args: [platform],
    });
    if (!r.rows[0]) throw new Error(`Quota row missing for ${platform}`);
    return row<Quota>(r.rows[0]);
  },
  async all(): Promise<Quota[]> {
    const r = await client.execute("SELECT * FROM quotas ORDER BY platform;");
    return r.rows.map(row<Quota>);
  },
  async update(
    platform: Quota["platform"],
    patch: Partial<Omit<Quota, "platform" | "updated_at">>,
  ): Promise<void> {
    const fields = safeFields("quotas", patch);
    if (!fields.length) return;
    await client.execute({
      sql: `UPDATE quotas SET ${fields.map((f) => `${f}=?`).join(", ")}, updated_at=unixepoch() WHERE platform=?;`,
      args: [...fields.map((f) => (patch as Record<string, unknown>)[f] as number), platform],
    });
  },
};

export const sessionsRepo = {
  async create(account_id: number, actions_planned: unknown): Promise<number> {
    const r = await client.execute({
      sql: "INSERT INTO session_runs (account_id, actions_planned_json) VALUES (?, ?);",
      args: [account_id, JSON.stringify(actions_planned)],
    });
    return Number(r.lastInsertRowid);
  },
  async recordActions(id: number, stats: unknown): Promise<void> {
    await client.execute({
      sql: "UPDATE session_runs SET actions_performed_json=? WHERE id=?;",
      args: [JSON.stringify(stats), id],
    });
  },
  async updateMetrics(
    id: number,
    patch: Partial<
      Pick<
        SessionRun,
        | "followers_before"
        | "followers_after"
        | "following_before"
        | "following_after"
        | "duoplus_task_id"
      >
    >,
  ): Promise<void> {
    const fields = safeFields("session_runs", patch);
    if (!fields.length) return;
    await client.execute({
      sql: `UPDATE session_runs SET ${fields.map((f) => `${f}=?`).join(", ")} WHERE id=?;`,
      args: [...fields.map((f) => (patch as Record<string, unknown>)[f] as number | string | null), id],
    });
  },
  async finish(id: number, status: string, error?: string): Promise<void> {
    await client.execute({
      sql: "UPDATE session_runs SET ended_at=unixepoch(), status=?, error=? WHERE id=?;",
      args: [status, error ?? null, id],
    });
  },
  async recentForAccount(account_id: number, limit = 10): Promise<SessionRun[]> {
    const r = await client.execute({
      sql: "SELECT * FROM session_runs WHERE account_id=? ORDER BY started_at DESC LIMIT ?;",
      args: [account_id, limit],
    });
    return r.rows.map(row<SessionRun>);
  },
  async dailySummary(account_id: number): Promise<{ runs: number; followers_delta: number }> {
    const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS runs,
                   SUM(COALESCE(followers_after, 0) - COALESCE(followers_before, 0)) AS followers_delta
              FROM session_runs
             WHERE account_id=? AND started_at >= ?;`,
      args: [account_id, startOfDay],
    });
    const first = r.rows[0];
    return {
      runs: first ? Number(first.runs ?? 0) : 0,
      followers_delta: first ? Number(first.followers_delta ?? 0) : 0,
    };
  },
};

export const followTargetsRepo = {
  async list(): Promise<FollowTarget[]> {
    const r = await client.execute(
      "SELECT * FROM follow_targets ORDER BY platform, handle;",
    );
    return r.rows.map(row<FollowTarget>);
  },
  async byPlatform(platform: string): Promise<FollowTarget[]> {
    const r = await client.execute({
      sql: "SELECT * FROM follow_targets WHERE platform=? AND enabled=1 ORDER BY handle;",
      args: [platform],
    });
    return r.rows.map(row<FollowTarget>);
  },
  async create(data: {
    platform: FollowTarget["platform"];
    handle: string;
    min_followers?: number;
    max_followers?: number | null;
    min_posts?: number;
    max_following?: number | null;
    require_avatar?: number;
    skip_private?: number;
    notes?: string | null;
  }): Promise<number> {
    const r = await client.execute({
      sql: `INSERT INTO follow_targets
              (platform, handle, min_followers, max_followers, min_posts, max_following,
               require_avatar, skip_private, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        data.platform,
        data.handle,
        data.min_followers ?? 0,
        data.max_followers ?? null,
        data.min_posts ?? 0,
        data.max_following ?? null,
        data.require_avatar ?? 1,
        data.skip_private ?? 1,
        data.notes ?? null,
      ],
    });
    return Number(r.lastInsertRowid);
  },
  async update(id: number, patch: Partial<Omit<FollowTarget, "id" | "created_at">>): Promise<void> {
    const fields = safeFields("follow_targets", patch);
    if (!fields.length) return;
    await client.execute({
      sql: `UPDATE follow_targets SET ${fields.map((f) => `${f}=?`).join(", ")} WHERE id=?;`,
      args: [...fields.map((f) => (patch as Record<string, unknown>)[f] as number | string | null), id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM follow_targets WHERE id=?;", args: [id] });
  },
};

export const scheduledPostsRepo = {
  async list(): Promise<ScheduledPost[]> {
    const r = await client.execute(
      "SELECT * FROM scheduled_posts ORDER BY COALESCE(scheduled_at, created_at) ASC;",
    );
    return r.rows.map(row<ScheduledPost>);
  },
  async due(
    platform: string,
    atTs: number = Math.floor(Date.now() / 1000),
  ): Promise<ScheduledPost[]> {
    const r = await client.execute({
      // scheduled_at IS NULL means "drafted but not yet scheduled" — those
      // must NOT be picked up by the poller or a failed post without a retry
      // timer would be retried forever.
      sql: `SELECT * FROM scheduled_posts
              WHERE platform=? AND status='queued'
                AND scheduled_at IS NOT NULL AND scheduled_at <= ?
              ORDER BY scheduled_at ASC
              LIMIT 5;`,
      args: [platform, atTs],
    });
    return r.rows.map(row<ScheduledPost>);
  },
  async create(data: {
    account_id?: number | null;
    platform: ScheduledPost["platform"];
    caption?: string;
    media_urls?: string[];
    scheduled_at?: number | null;
  }): Promise<number> {
    const r = await client.execute({
      sql: `INSERT INTO scheduled_posts (account_id, platform, caption, media_urls_json, scheduled_at)
            VALUES (?, ?, ?, ?, ?);`,
      args: [
        data.account_id ?? null,
        data.platform,
        data.caption ?? null,
        data.media_urls ? JSON.stringify(data.media_urls) : null,
        data.scheduled_at ?? null,
      ],
    });
    return Number(r.lastInsertRowid);
  },
  async updateStatus(
    id: number,
    status: ScheduledPost["status"],
    error?: string,
  ): Promise<void> {
    await client.execute({
      sql: `UPDATE scheduled_posts
              SET status=?, error=?,
                  posted_at = CASE WHEN ?='posted' THEN unixepoch() ELSE posted_at END
            WHERE id=?;`,
      args: [status, error ?? null, status, id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM scheduled_posts WHERE id=?;", args: [id] });
  },
};

export const batchRunsRepo = {
  async create(data: { run_id: string; automation: string; device_ids: string[] }): Promise<void> {
    await client.execute({
      sql: "INSERT INTO batch_runs (run_id, automation, device_ids_json) VALUES (?, ?, ?);",
      args: [data.run_id, data.automation, JSON.stringify(data.device_ids)],
    });
  },
  async finish(run_id: string, status: BatchRun["status"]): Promise<void> {
    await client.execute({
      sql: "UPDATE batch_runs SET status=?, ended_at=unixepoch() WHERE run_id=?;",
      args: [status, run_id],
    });
  },
  async get(run_id: string): Promise<BatchRun | null> {
    const r = await client.execute({
      sql: "SELECT * FROM batch_runs WHERE run_id=?;",
      args: [run_id],
    });
    return r.rows[0] ? row<BatchRun>(r.rows[0]) : null;
  },
  async recent(limit = 40): Promise<BatchRun[]> {
    const r = await client.execute({
      sql: "SELECT * FROM batch_runs ORDER BY started_at DESC LIMIT ?;",
      args: [limit],
    });
    return r.rows.map(row<BatchRun>);
  },
  async stillRunning(): Promise<BatchRun[]> {
    const r = await client.execute("SELECT * FROM batch_runs WHERE status='running';");
    return r.rows.map(row<BatchRun>);
  },
};

export interface EventLog {
  id: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error" | "ok";
  code: string;
  msg: string;
  run_id: string | null;
  device_id: string | null;
  platform: string | null;
  username: string | null;
  account_id: number | null;
  phase: string | null;
  attempt: number | null;
  json: string | null;
  stack: string | null;
}

export interface EventLogInput {
  level: EventLog["level"];
  code: string;
  msg: string;
  run_id?: string | null;
  device_id?: string | null;
  platform?: string | null;
  username?: string | null;
  account_id?: number | null;
  phase?: string | null;
  attempt?: number | null;
  json?: unknown;
  stack?: string | null;
}

export const eventLogsRepo = {
  async record(e: EventLogInput): Promise<void> {
    let jsonStr: string | null = null;
    if (e.json !== undefined && e.json !== null) {
      try { jsonStr = JSON.stringify(e.json); } catch { jsonStr = null; }
    }
    await client.execute({
      sql: `INSERT INTO event_logs
              (level, code, msg, run_id, device_id, platform, username,
               account_id, phase, attempt, json, stack)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        e.level, e.code, e.msg,
        e.run_id ?? null, e.device_id ?? null, e.platform ?? null,
        e.username ?? null, e.account_id ?? null,
        e.phase ?? null, e.attempt ?? null,
        jsonStr, e.stack ?? null,
      ],
    });
  },
  async recent(limit = 200): Promise<EventLog[]> {
    const r = await client.execute({
      sql: "SELECT * FROM event_logs ORDER BY ts DESC, id DESC LIMIT ?;",
      args: [limit],
    });
    return r.rows.map(row<EventLog>);
  },
  async filter(opts: {
    code?: string;
    device_id?: string;
    username?: string;
    level?: EventLog["level"];
    sinceTs?: number;
    limit?: number;
  }): Promise<EventLog[]> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.code) { where.push("code=?"); args.push(opts.code); }
    if (opts.device_id) { where.push("device_id=?"); args.push(opts.device_id); }
    if (opts.username) { where.push("username=?"); args.push(opts.username); }
    if (opts.level) { where.push("level=?"); args.push(opts.level); }
    if (opts.sinceTs) { where.push("ts>=?"); args.push(opts.sinceTs); }
    const sql =
      "SELECT * FROM event_logs" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY ts DESC, id DESC LIMIT ?;";
    args.push(opts.limit ?? 200);
    const r = await client.execute({ sql, args });
    return r.rows.map(row<EventLog>);
  },
  async clearOlderThan(days: number): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    await client.execute({
      sql: "DELETE FROM event_logs WHERE ts < ?;",
      args: [cutoff],
    });
  },
};

// ---------------------------------------------------------------------------
// Account requests — operator attention queue for slots that need a human.
// ---------------------------------------------------------------------------

export interface AccountRequest {
  id: number;
  device_id: string;
  platform: "instagram" | "threads" | "tiktok";
  reason: string;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  hit_count: number;
}

export const accountRequestsRepo = {
  /**
   * Upsert a pending request for (device, platform). If one already exists:
   * bump last_seen_at + hit_count and optionally replace the reason. If not:
   * INSERT a fresh pending row. The partial UNIQUE index guarantees at most
   * one pending row per slot.
   */
  async flag(data: {
    device_id: string;
    platform: AccountRequest["platform"];
    reason: string;
  }): Promise<number> {
    const existing = await client.execute({
      sql: `SELECT id FROM account_requests
              WHERE device_id=? AND platform=? AND resolved_at IS NULL
              LIMIT 1;`,
      args: [data.device_id, data.platform],
    });
    if (existing.rows[0]) {
      const id = Number(existing.rows[0].id);
      await client.execute({
        sql: `UPDATE account_requests
                SET last_seen_at=unixepoch(),
                    hit_count=hit_count+1,
                    reason=?
              WHERE id=?;`,
        args: [data.reason, id],
      });
      return id;
    }
    const r = await client.execute({
      sql: `INSERT INTO account_requests (device_id, platform, reason) VALUES (?, ?, ?);`,
      args: [data.device_id, data.platform, data.reason],
    });
    return Number(r.lastInsertRowid);
  },
  async listPending(): Promise<AccountRequest[]> {
    const r = await client.execute(
      "SELECT * FROM account_requests WHERE resolved_at IS NULL ORDER BY last_seen_at DESC;",
    );
    return r.rows.map(row<AccountRequest>);
  },
  async listAll(limit = 100): Promise<AccountRequest[]> {
    const r = await client.execute({
      sql: "SELECT * FROM account_requests ORDER BY last_seen_at DESC LIMIT ?;",
      args: [limit],
    });
    return r.rows.map(row<AccountRequest>);
  },
  async resolve(id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE account_requests SET resolved_at=unixepoch() WHERE id=? AND resolved_at IS NULL;",
      args: [id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM account_requests WHERE id=?;", args: [id] });
  },
};

// ---------------------------------------------------------------------------
// Screen patterns — operator-curated learned recoveries.
// ---------------------------------------------------------------------------

export type SignatureRule = {
  type: "text" | "desc" | "resource-id" | "focus";
  contains: string;
};

export type RecoveryAction =
  | "tap_text"
  | "tap_desc"
  | "tap_resource_id"
  | "press_back"
  | "swipe_down"
  | "relaunch";

export interface ScreenPattern {
  id: number;
  name: string;
  platform: string | null;
  enabled: number;                 // 0 | 1 (libsql can't INTEGER → boolean)
  signature_json: string;          // JSON-encoded SignatureRule[]
  recovery_action: RecoveryAction;
  recovery_arg: string | null;
  times_matched: number;
  times_recovered: number;
  last_matched_at: number | null;
  source_unknown_id: number | null;
  notes: string | null;
  created_at: number;
}

const VALID_RECOVERY: ReadonlySet<RecoveryAction> = new Set([
  "tap_text", "tap_desc", "tap_resource_id", "press_back", "swipe_down", "relaunch",
]);

const VALID_SIG_TYPE: ReadonlySet<SignatureRule["type"]> = new Set([
  "text", "desc", "resource-id", "focus",
]);

/** Validate + normalize a signature payload from the API. Throws on bad input. */
function validateSignature(input: unknown): SignatureRule[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("signature must be a non-empty array of {type, contains}");
  }
  if (input.length > 8) throw new Error("signature can have at most 8 rules");
  const out: SignatureRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("signature rule must be an object");
    const type = (raw as Record<string, unknown>).type;
    const contains = (raw as Record<string, unknown>).contains;
    if (typeof type !== "string" || !VALID_SIG_TYPE.has(type as SignatureRule["type"])) {
      throw new Error(`invalid signature.type "${type}"`);
    }
    if (typeof contains !== "string" || contains.length === 0 || contains.length > 200) {
      throw new Error("signature.contains must be 1-200 chars");
    }
    out.push({ type: type as SignatureRule["type"], contains });
  }
  return out;
}

export const screenPatternsRepo = {
  async list(opts: { platform?: string; enabledOnly?: boolean } = {}): Promise<ScreenPattern[]> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.enabledOnly) where.push("enabled=1");
    if (opts.platform) {
      where.push("(platform IS NULL OR platform=?)");
      args.push(opts.platform);
    }
    const sql =
      "SELECT * FROM screen_patterns" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY times_recovered DESC, created_at DESC;";
    const r = await client.execute({ sql, args });
    return r.rows.map(row<ScreenPattern>);
  },
  async create(data: {
    name: string;
    platform?: string | null;
    signature: SignatureRule[];
    recovery_action: RecoveryAction;
    recovery_arg?: string | null;
    source_unknown_id?: number | null;
    notes?: string | null;
  }): Promise<number> {
    if (!data.name.trim()) throw new Error("name required");
    if (!VALID_RECOVERY.has(data.recovery_action)) {
      throw new Error(`invalid recovery_action "${data.recovery_action}"`);
    }
    // Actions that need an argument must have one; ones that don't must NOT.
    const needsArg = data.recovery_action === "tap_text" ||
      data.recovery_action === "tap_desc" ||
      data.recovery_action === "tap_resource_id";
    if (needsArg && !data.recovery_arg) {
      throw new Error(`recovery_action ${data.recovery_action} requires recovery_arg`);
    }
    if (!needsArg && data.recovery_arg) {
      throw new Error(`recovery_action ${data.recovery_action} must not have recovery_arg`);
    }
    const sig = validateSignature(data.signature);
    const r = await client.execute({
      sql: `INSERT INTO screen_patterns
              (name, platform, enabled, signature_json, recovery_action, recovery_arg,
               source_unknown_id, notes)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?);`,
      args: [
        data.name.trim(),
        data.platform ?? null,
        JSON.stringify(sig),
        data.recovery_action,
        data.recovery_arg ?? null,
        data.source_unknown_id ?? null,
        data.notes ?? null,
      ],
    });
    return Number(r.lastInsertRowid);
  },
  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await client.execute({
      sql: "UPDATE screen_patterns SET enabled=? WHERE id=?;",
      args: [enabled ? 1 : 0, id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM screen_patterns WHERE id=?;", args: [id] });
  },
  /** Atomic counters — called from the runtime classifier on every match/recovery. */
  async incrementMatched(id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE screen_patterns SET times_matched=times_matched+1, last_matched_at=unixepoch() WHERE id=?;",
      args: [id],
    });
  },
  async incrementRecovered(id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE screen_patterns SET times_recovered=times_recovered+1 WHERE id=?;",
      args: [id],
    });
  },
};

export const batchRunLogsRepo = {
  async append(run_id: string, level: string, msg: string): Promise<void> {
    await client.execute({
      // ts is Unix seconds, matching every other ts column in this schema.
      sql: "INSERT INTO batch_run_logs (run_id, ts, level, msg) VALUES (?, ?, ?, ?);",
      args: [run_id, Math.floor(Date.now() / 1000), level, msg],
    });
  },
  async since(run_id: string, afterId = 0): Promise<BatchRunLog[]> {
    const r = await client.execute({
      sql: "SELECT * FROM batch_run_logs WHERE run_id=? AND id > ? ORDER BY id ASC LIMIT 500;",
      args: [run_id, afterId],
    });
    return r.rows.map(row<BatchRunLog>);
  },
};

export const unknownScreensRepo = {
  async list(limit = 200): Promise<UnknownScreen[]> {
    const r = await client.execute({
      sql: "SELECT * FROM unknown_screens ORDER BY ts DESC LIMIT ?;",
      args: [limit],
    });
    return r.rows.map(row<UnknownScreen>);
  },
  async record(data: {
    device_id: string;
    platform?: string | null;
    context?: string;
    focus?: string;
    xml_head?: string;
    recovered?: boolean;
    recovery_action?: string;
    screenshot_path?: string | null;
    analysis?: string | null;
  }): Promise<number> {
    const r = await client.execute({
      sql: `INSERT INTO unknown_screens
              (device_id, platform, context, focus, xml_head, recovered, recovery_action,
               screenshot_path, analysis)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        data.device_id,
        data.platform ?? null,
        data.context ?? null,
        data.focus ?? null,
        (data.xml_head ?? "").slice(0, 8192),
        data.recovered ? 1 : 0,
        data.recovery_action ?? null,
        data.screenshot_path ?? null,
        data.analysis ?? null,
      ],
    });
    return Number(r.lastInsertRowid);
  },
  async updateAnalysis(id: number, analysis: string): Promise<void> {
    await client.execute({
      sql: "UPDATE unknown_screens SET analysis=? WHERE id=?;",
      args: [analysis, id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM unknown_screens WHERE id=?;", args: [id] });
  },
  async clearOlderThan(days: number): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    await client.execute({
      sql: "DELETE FROM unknown_screens WHERE ts < ?;",
      args: [cutoff],
    });
  },
};

// Public view of a login-queue row with credentials removed. Used for any
// response that crosses a trust boundary (HTTP, logs). Internal callers that
// must drive the login flow use loginQueueRepo.getCredentials(id).
export type LoginQueueRowSafe = Omit<LoginQueueRow, "password" | "totp_secret">;

const SAFE_LOGIN_COLUMNS =
  "id, platform, username, assigned_device_id, status, error, account_id, created_at, finished_at";

export const loginQueueRepo = {
  async list(): Promise<LoginQueueRowSafe[]> {
    const r = await client.execute(
      `SELECT ${SAFE_LOGIN_COLUMNS} FROM login_queue ORDER BY created_at DESC;`,
    );
    return r.rows.map(row<LoginQueueRowSafe>);
  },
  async getCredentials(id: number): Promise<LoginQueueRow | null> {
    const r = await client.execute({
      sql: "SELECT * FROM login_queue WHERE id=?;",
      args: [id],
    });
    return r.rows[0] ? row<LoginQueueRow>(r.rows[0]) : null;
  },
  async pending(platform?: string): Promise<LoginQueueRow[]> {
    if (platform) {
      const r = await client.execute({
        sql: "SELECT * FROM login_queue WHERE status='pending' AND platform=? ORDER BY created_at ASC;",
        args: [platform],
      });
      return r.rows.map(row<LoginQueueRow>);
    }
    const r = await client.execute(
      "SELECT * FROM login_queue WHERE status='pending' ORDER BY created_at ASC;",
    );
    return r.rows.map(row<LoginQueueRow>);
  },
  /**
   * Pending logins explicitly targeted at this device (assigned_device_id set
   * but status still pending). Used by the runner so a device only claims
   * credentials that have been routed to it — credentials in the global pool
   * (assigned_device_id IS NULL) require explicit assignment via poolRepo.
   */
  async pendingForDevice(device_id: string, platform?: string): Promise<LoginQueueRow[]> {
    const sql = platform
      ? "SELECT * FROM login_queue WHERE status='pending' AND assigned_device_id=? AND platform=? ORDER BY created_at ASC;"
      : "SELECT * FROM login_queue WHERE status='pending' AND assigned_device_id=? ORDER BY created_at ASC;";
    const args = platform ? [device_id, platform] : [device_id];
    const r = await client.execute({ sql, args });
    return r.rows.map(row<LoginQueueRow>);
  },
  async claimFor(id: number, device_id: string): Promise<boolean> {
    const r = await client.execute({
      sql: "UPDATE login_queue SET status='assigned', assigned_device_id=? WHERE id=? AND status='pending';",
      args: [device_id, id],
    });
    return r.rowsAffected > 0;
  },
  async create(data: {
    platform: LoginQueueRow["platform"];
    username: string;
    password: string;
    totp_secret?: string | null;
  }): Promise<number> {
    const r = await client.execute({
      sql: "INSERT INTO login_queue (platform, username, password, totp_secret) VALUES (?, ?, ?, ?);",
      args: [data.platform, data.username, data.password, data.totp_secret ?? null],
    });
    return Number(r.lastInsertRowid);
  },
  async markStarted(id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE login_queue SET status='logging-in' WHERE id=?;",
      args: [id],
    });
  },
  async markSuccess(id: number, account_id: number): Promise<void> {
    await client.execute({
      sql: "UPDATE login_queue SET status='success', account_id=?, finished_at=unixepoch() WHERE id=?;",
      args: [account_id, id],
    });
  },
  async markFailed(id: number, error: string): Promise<void> {
    await client.execute({
      sql: "UPDATE login_queue SET status='failed', error=?, finished_at=unixepoch() WHERE id=?;",
      args: [error, id],
    });
  },
  async delete(id: number): Promise<void> {
    await client.execute({ sql: "DELETE FROM login_queue WHERE id=?;", args: [id] });
  },
};

/**
 * Pool of warmed/aged credentials waiting to be slotted onto a device. We
 * reuse `login_queue` for storage (every row is a credential after all) — a
 * row is "in the pool" when status='pending' AND assigned_device_id IS NULL.
 *
 * Auto-rotation flow:
 *   1. Account on device X is flagged → marked suspended/verification-required.
 *   2. Runner calls poolRepo.claimForRotation(device_id, platform).
 *   3. The atomic UPDATE binds the first available pool row to device X.
 *   4. On the device's next wake, runner sees the assigned row via
 *      loginQueueRepo.pendingForDevice(...) and runs the IG/Threads login flow.
 */
export const poolRepo = {
  async list(platform?: string): Promise<LoginQueueRowSafe[]> {
    const sql = platform
      ? `SELECT ${SAFE_LOGIN_COLUMNS} FROM login_queue
           WHERE status='pending' AND assigned_device_id IS NULL AND platform=?
           ORDER BY created_at ASC;`
      : `SELECT ${SAFE_LOGIN_COLUMNS} FROM login_queue
           WHERE status='pending' AND assigned_device_id IS NULL
           ORDER BY created_at ASC;`;
    const args = platform ? [platform] : [];
    const r = await client.execute({ sql, args });
    return r.rows.map(row<LoginQueueRowSafe>);
  },
  /**
   * Bind a specific pool row to a device. Returns false if the row was already
   * claimed (concurrent rotation on another device). Status stays 'pending'
   * so loginQueueRepo.pendingForDevice() will pick it up next wake.
   */
  async assign(loginId: number, device_id: string): Promise<boolean> {
    const r = await client.execute({
      sql: `UPDATE login_queue
              SET assigned_device_id=?
            WHERE id=?
              AND status='pending'
              AND assigned_device_id IS NULL;`,
      args: [device_id, loginId],
    });
    return r.rowsAffected > 0;
  },
  /**
   * Atomically pick the oldest pool row for `platform` (FIFO) and bind it to
   * `device_id`. Returns the bound row's id, or null if the pool is empty.
   * Race-safe: the WHERE id IN (SELECT … LIMIT 1) + check on assigned_device_id
   * means two rotations on different devices won't grab the same row.
   */
  async claimForRotation(
    device_id: string,
    platform: LoginQueueRow["platform"],
  ): Promise<number | null> {
    const candidate = await client.execute({
      sql: `SELECT id FROM login_queue
              WHERE status='pending' AND assigned_device_id IS NULL AND platform=?
              ORDER BY created_at ASC
              LIMIT 1;`,
      args: [platform],
    });
    const id = candidate.rows[0]?.id as number | undefined;
    if (!id) return null;
    const ok = await this.assign(Number(id), device_id);
    return ok ? Number(id) : null;
  },
};

export const growthRepo = {
  async record(
    account_id: number,
    followers: number | null,
    following: number | null,
    posts: number | null,
  ): Promise<void> {
    await client.execute({
      sql: "INSERT INTO growth_snapshots (account_id, followers, following, posts) VALUES (?, ?, ?, ?);",
      args: [account_id, followers, following, posts],
    });
  },
  async latest(
    account_id: number,
  ): Promise<{ followers: number | null; following: number | null; posts: number | null; ts: number } | null> {
    const r = await client.execute({
      sql: "SELECT followers, following, posts, ts FROM growth_snapshots WHERE account_id=? ORDER BY ts DESC LIMIT 1;",
      args: [account_id],
    });
    return r.rows[0]
      ? row<{ followers: number | null; following: number | null; posts: number | null; ts: number }>(r.rows[0])
      : null;
  },
  async series(
    account_id: number,
    sinceDays = 14,
  ): Promise<Array<{ ts: number; followers: number | null; following: number | null; posts: number | null }>> {
    const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const r = await client.execute({
      sql: "SELECT ts, followers, following, posts FROM growth_snapshots WHERE account_id=? AND ts>=? ORDER BY ts ASC;",
      args: [account_id, cutoff],
    });
    return r.rows.map(
      row<{ ts: number; followers: number | null; following: number | null; posts: number | null }>,
    );
  },
};

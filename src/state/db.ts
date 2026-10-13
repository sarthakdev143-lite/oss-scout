import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * SQLite schema. Bump SCHEMA_VERSION and append a migration when changing it; never edit
 * an applied migration.
 */
const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS repos (
    full_name      TEXT PRIMARY KEY COLLATE NOCASE,
    source         TEXT NOT NULL,
    source_detail  TEXT,
    status         TEXT NOT NULL DEFAULT 'candidate',
    score          REAL,
    reasons        TEXT NOT NULL DEFAULT '[]',
    skip_reason    TEXT,
    policy         TEXT,
    metrics        TEXT,
    discovered_at  INTEGER NOT NULL,
    screened_at    INTEGER,
    next_screen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS repos_status ON repos(status, next_screen_at);

  CREATE TABLE IF NOT EXISTS issues (
    id          TEXT PRIMARY KEY COLLATE NOCASE,
    repo        TEXT NOT NULL COLLATE NOCASE,
    number      INTEGER NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    labels      TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    comments    INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL DEFAULT 'other',
    status      TEXT NOT NULL DEFAULT 'candidate',
    score       REAL,
    reasons     TEXT NOT NULL DEFAULT '[]',
    skip_reason TEXT,
    fetched_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS issues_repo ON issues(repo, status);
  CREATE INDEX IF NOT EXISTS issues_status_score ON issues(status, score);

  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    repo          TEXT NOT NULL COLLATE NOCASE,
    issue_id      TEXT,
    pr_id         TEXT,
    stage         TEXT NOT NULL,
    status        TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    failures      INTEGER NOT NULL DEFAULT 0,
    next_run_at   INTEGER NOT NULL,
    last_error    TEXT,
    abort_reason  TEXT,
    workspace     TEXT,
    branch        TEXT,
    tokens_used   INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    data          TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, next_run_at);
  CREATE INDEX IF NOT EXISTS tasks_repo ON tasks(repo);

  CREATE TABLE IF NOT EXISTS queue_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL,
    repo            TEXT NOT NULL COLLATE NOCASE,
    issue_url       TEXT,
    pr_url          TEXT,
    task_id         TEXT,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    diff            TEXT NOT NULL DEFAULT '',
    test_output     TEXT NOT NULL DEFAULT '',
    critic          TEXT,
    verification    TEXT,
    branch          TEXT,
    workspace       TEXT,
    base_branch     TEXT,
    digest          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    decided_at      INTEGER,
    decision_reason TEXT,
    submitted_url   TEXT,
    error           TEXT,
    data            TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS queue_status ON queue_items(status);
  CREATE INDEX IF NOT EXISTS queue_repo ON queue_items(repo, status);

  CREATE TABLE IF NOT EXISTS prs (
    id                    TEXT PRIMARY KEY COLLATE NOCASE,
    repo                  TEXT NOT NULL COLLATE NOCASE,
    number                INTEGER NOT NULL,
    url                   TEXT NOT NULL,
    queue_item_id         INTEGER,
    branch                TEXT,
    head_repo             TEXT,
    state                 TEXT NOT NULL,
    opened_at             INTEGER NOT NULL,
    closed_at             INTEGER,
    merged_at             INTEGER,
    last_polled_at        INTEGER,
    last_seen_activity_at TEXT,
    data                  TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS prs_state ON prs(state);
  CREATE INDEX IF NOT EXISTS prs_repo ON prs(repo, state);

  CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    subject  TEXT,
    decision TEXT,
    reasons  TEXT NOT NULL DEFAULT '[]',
    details  TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
  CREATE INDEX IF NOT EXISTS audit_action ON audit(action, ts);
  CREATE INDEX IF NOT EXISTS audit_subject ON audit(subject, ts);

  CREATE TABLE IF NOT EXISTS errors (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    scope   TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS errors_ts ON errors(ts);

  CREATE TABLE IF NOT EXISTS usage (
    day      TEXT PRIMARY KEY,
    tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    calls    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS http_cache (
    key           TEXT PRIMARY KEY,
    etag          TEXT,
    last_modified TEXT,
    body          TEXT NOT NULL,
    fetched_at    INTEGER NOT NULL
  );
  `,
  /* v2: sticky issue decisions (human reject / task abort / task failure are never re-candidated) and
         per-task claims (a scheduler that lost its lease cannot overwrite a task another one advanced). */ `
  ALTER TABLE issues ADD COLUMN sticky INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
  ALTER TABLE tasks ADD COLUMN claim_expires_at INTEGER;
  CREATE INDEX IF NOT EXISTS http_cache_fetched ON http_cache(fetched_at);
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * Open (creating if needed) the SQLite database and apply migrations.
 * Use ":memory:" for tests.
 */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true, strict: true })
  db.exec("PRAGMA busy_timeout = 5000;")
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null
  let version = row ? Number(row.value) : 0
  if (version > MIGRATIONS.length) {
    throw new Error(
      `oss-scout database schema v${version} is newer than this build supports (v${MIGRATIONS.length}). Upgrade oss-scout.`,
    )
  }
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!
    const next = version + 1
    db.transaction(() => {
      db.exec(sql)
      db.query("INSERT INTO meta(key, value) VALUES ('schema_version', $v) ON CONFLICT(key) DO UPDATE SET value = $v").run({
        v: String(next),
      })
    })()
    version = next
  }
}

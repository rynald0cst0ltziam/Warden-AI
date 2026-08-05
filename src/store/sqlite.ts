/**
 * Local-first state store backed by Node's built-in `node:sqlite`.
 *
 * No native dependencies, no network. Mirrors Caveman's "prompts never leave
 * the machine" trust promise — and extends it: eval state stays local too.
 *
 * Schema covers the Phase 1 loop: rules (pruning strategies + their lifecycle
 * stage), shadow_runs (the eval-gate evidence), decisions (audit trail of
 * every prune / promote / revert), and config_snapshots (immutable
 * last-known-good configs the watchdog would roll back to in Phase 2).
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../logging/index.js";
import type { RuleStage } from "../eval/types.js";
import { loadSqlite, type DatabaseSync } from "./sqlite-loader.js";

export type { RuleStage };

export interface RuleRow {
  id: string;
  tool_type: string;
  name: string;
  stage: RuleStage;
  created_at: string;
  promoted_at: string | null;
  reverted_at: string | null;
  revert_reason: string | null;
  config_json: string;
}

export interface ShadowRunRow {
  id: number;
  rule_id: string;
  tool_type: string;
  timestamp: string;
  parity_score: number; // 0..1
  tokens_full: number;
  tokens_pruned: number;
  notes: string | null;
}

export interface DecisionRow {
  id: number;
  timestamp: string;
  kind: string; // "prune" | "promote" | "revert" | "canary" | "observe"
  rule_id: string | null;
  tool_type: string | null;
  tokens_saved: number;
  detail_json: string;
}

export interface ConfigSnapshotRow {
  id: number;
  timestamp: string;
  config_json: string;
  canary_clean: 0 | 1;
}

export interface MemoryRow {
  id: number;
  timestamp: string;
  category: string;
  title: string;
  body: string;
  tags_json: string;
  source: string | null;
  confidence: number;
  accessed_at: string | null;
  access_count: number;
}

export interface ContextSelectionRow {
  id: number;
  timestamp: string;
  task: string;
  files_json: string;
  reasoning: string | null;
}

export interface CcrRow {
  hash: string;
  raw_output: string;
  tool_type: string;
  rule_id: string;
  tokens_full: number;
  tokens_pruned: number;
  created_at: string;
  accessed_at: string | null;
  access_count: number;
}

export class SqliteStore {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    // Wait up to 5s for a lock instead of throwing SQLITE_BUSY immediately.
    // Two agent sessions can open the same project DB at once (e.g. the MCP
    // server plus `warden hud`/`warden dashboard`); WAL + busy_timeout lets
    // them coexist without crashing.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  /** Async factory — loads `node:sqlite` dynamically to survive bundling. */
  static async open(path: string): Promise<SqliteStore> {
    if (!existsSync(dirname(path)))
      mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    return new SqliteStore(db);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id           TEXT PRIMARY KEY,
        tool_type    TEXT NOT NULL,
        name         TEXT NOT NULL,
        stage        TEXT NOT NULL DEFAULT 'shadow',
        created_at   TEXT NOT NULL,
        promoted_at  TEXT,
        reverted_at  TEXT,
        revert_reason TEXT,
        config_json  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS shadow_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id       TEXT NOT NULL,
        tool_type     TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        parity_score  REAL NOT NULL,
        tokens_full   INTEGER NOT NULL,
        tokens_pruned INTEGER NOT NULL,
        notes         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_rule ON shadow_runs(rule_id, timestamp);
      CREATE TABLE IF NOT EXISTS decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        rule_id     TEXT,
        tool_type   TEXT,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        config_json TEXT NOT NULL,
        canary_clean INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT 'decision',
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        tags_json   TEXT NOT NULL DEFAULT '[]',
        source      TEXT,
        confidence  REAL NOT NULL DEFAULT 1.0,
        accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_ts ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_cat ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at);
      -- FTS5 virtual table for full-text memory search is created in
      -- ensureMemoryFts() to handle migrations from older DB schemas.
      CREATE TABLE IF NOT EXISTS context_selections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        task        TEXT NOT NULL,
        files_json  TEXT NOT NULL DEFAULT '[]',
        reasoning   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_context_ts ON context_selections(timestamp);
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        task        TEXT NOT NULL,
        success     INTEGER NOT NULL,
        pruned      INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_ts ON task_outcomes(timestamp);

      -- Code index tables (Layer 0: structural code intelligence)
      CREATE TABLE IF NOT EXISTS index_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT NOT NULL,
        rel_path      TEXT NOT NULL,
        abs_path      TEXT NOT NULL,
        mtime         REAL NOT NULL,
        symbol_count  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_index_files_project ON index_files(project);
      CREATE TABLE IF NOT EXISTS index_symbols (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        start_line    INTEGER NOT NULL,
        end_line      INTEGER NOT NULL,
        exported      INTEGER NOT NULL DEFAULT 0,
        is_async      INTEGER NOT NULL DEFAULT 0,
        params_json   TEXT NOT NULL DEFAULT '[]',
        class_name    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_index_symbols_name ON index_symbols(project, name);
      CREATE INDEX IF NOT EXISTS idx_index_symbols_file ON index_symbols(project, file_path);
      CREATE INDEX IF NOT EXISTS idx_index_symbols_kind ON index_symbols(project, kind);
      CREATE TABLE IF NOT EXISTS index_imports (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        line          INTEGER NOT NULL,
        names_json    TEXT NOT NULL DEFAULT '[]',
        from_module   TEXT NOT NULL,
        resolved_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_index_imports_file ON index_imports(project, file_path);
      CREATE INDEX IF NOT EXISTS idx_index_imports_resolved ON index_imports(project, resolved_path);
      CREATE TABLE IF NOT EXISTS index_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        line          INTEGER NOT NULL,
        caller_name   TEXT NOT NULL,
        callee_name   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_index_calls_callee ON index_calls(project, callee_name);
      CREATE INDEX IF NOT EXISTS idx_index_calls_caller ON index_calls(project, caller_name);
      CREATE INDEX IF NOT EXISTS idx_index_calls_file ON index_calls(project, file_path);

      -- CCR (Compress-Cache-Retrieve): reversible pruning storage.
      -- When pruning removes content, the original is stored here with a hash
      -- key. The agent can call warden_retrieve to get the full original back.
      CREATE TABLE IF NOT EXISTS ccr_cache (
        hash         TEXT PRIMARY KEY,
        raw_output   TEXT NOT NULL,
        tool_type    TEXT NOT NULL,
        rule_id      TEXT NOT NULL,
        tokens_full  INTEGER NOT NULL,
        tokens_pruned INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        accessed_at  TEXT,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ccr_created ON ccr_cache(created_at);
    `);

    // Additive migrations for DBs created by older Warden versions. Each call
    // is a no-op if the column already exists, so this is safe to run on every
    // open. Heals early-alpha DBs that predate these columns instead of
    // crashing on a missing column at query time. Add future columns here
    // rather than editing the CREATE TABLE blocks above.
    this.ensureColumn("memories", "accessed_at", "TEXT");
    this.ensureColumn("memories", "access_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memories", "confidence", "REAL NOT NULL DEFAULT 1.0");
    this.ensureColumn("memories", "source", "TEXT");
    // Ensure FTS5 table + triggers exist (migration for older DBs)
    this.ensureMemoryFts();
  }

  /**
   * Ensure the FTS5 virtual table exists and is the correct (standalone)
   * version. Always drops and recreates to handle migrations from older
   * broken external-content FTS5 tables. Backfills from memories table.
   * This is cheap — FTS5 rebuild is fast for memory-sized data.
   */
  private ensureMemoryFts(): void {
    try {
      // Drop old triggers from the external-content FTS5 schema.
      // These triggers reference the FTS table with external-content syntax
      // which is incompatible with the standalone FTS5 table we use now.
      // If they remain, UPDATE/INSERT/DELETE on memories will fail.
      try {
        this.db.exec("DROP TRIGGER IF EXISTS memories_ai;");
        this.db.exec("DROP TRIGGER IF EXISTS memories_ad;");
        this.db.exec("DROP TRIGGER IF EXISTS memories_au;");
      } catch {
        // Non-fatal — triggers may not exist
      }

      // Always drop and recreate — handles old broken external-content tables
      // and ensures the FTS index is in sync with the memories table.
      try {
        this.db.exec("DROP TABLE IF EXISTS memories_fts;");
      } catch {
        // DROP may fail if table doesn't exist — that's fine
      }

      // Create standalone FTS5 table (no external content)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          title,
          body,
          tags,
          tokenize='porter unicode61'
        );
      `);

      // Backfill: insert all existing memories into the FTS index.
      const memCount = this.db
        .prepare("SELECT COUNT(*) AS c FROM memories")
        .get() as { c: number };
      if (memCount.c > 0) {
        const rows = this.db
          .prepare("SELECT id, title, body, tags_json FROM memories")
          .all() as Array<{
            id: number;
            title: string;
            body: string;
            tags_json: string;
          }>;
        const insertFts = this.db.prepare(
          "INSERT INTO memories_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)",
        );
        for (const row of rows) {
          try {
            insertFts.run(row.id, row.title, row.body, row.tags_json);
          } catch {
            // Skip duplicate rowids
          }
        }
        logger.info("FTS5 index backfilled", { memories: memCount.c });
      }
    } catch (err) {
      // FTS5 not available or migration failed — recall will fall back to LIKE
      logger.warn("FTS5 migration failed (non-fatal — LIKE fallback active)", {
        err: String(err),
      });
    }
  }

  /** Add a column if it doesn't already exist. Idempotent, crash-safe. */
  private ensureColumn(table: string, column: string, type: string): void {
    // SQLite identifiers can't be bound as parameters, so these are interpolated.
    // Guard against anything that isn't a plain identifier / type so this can
    // never become an injection vector even if a caller passes dynamic input.
    const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!IDENT.test(table) || !IDENT.test(column) || !/^[A-Za-z0-9_ ()']+$/.test(type)) {
      logger.warn("refusing unsafe column migration", { table, column, type });
      return;
    }
    try {
      const cols = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as unknown as Array<{ name: string }>;
      if (cols.some((c) => c.name === column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info("migrated: added column", { table, column, type });
    } catch (err) {
      logger.warn("column migration failed (non-fatal)", {
        table,
        column,
        err: String(err),
      });
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      logger.warn("sqlite close failed", { err: String(err) });
    }
  }

  // ---- rules ----
  upsertRule(r: RuleRow): void {
    this.db
      .prepare(
        `INSERT INTO rules (id,tool_type,name,stage,created_at,promoted_at,reverted_at,revert_reason,config_json)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           stage=excluded.stage, promoted_at=excluded.promoted_at,
           reverted_at=excluded.reverted_at, revert_reason=excluded.revert_reason,
           config_json=excluded.config_json`,
      )
      .run(
        r.id,
        r.tool_type,
        r.name,
        r.stage,
        r.created_at,
        r.promoted_at,
        r.reverted_at,
        r.revert_reason,
        r.config_json,
      );
  }

  getRule(id: string): RuleRow | undefined {
    return this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as
      RuleRow | undefined;
  }

  listRules(): RuleRow[] {
    return this.db
      .prepare("SELECT * FROM rules ORDER BY created_at")
      .all() as unknown as RuleRow[];
  }

  setRuleStage(
    id: string,
    stage: RuleStage,
    reason: string | null = null,
  ): void {
    const now = new Date().toISOString();
    if (stage === "active" || stage === "canary") {
      this.db
        .prepare(
          "UPDATE rules SET stage=?, promoted_at=COALESCE(promoted_at,?) WHERE id=?",
        )
        .run(stage, now, id);
    } else if (stage === "reverted") {
      this.db
        .prepare(
          "UPDATE rules SET stage=?, reverted_at=?, revert_reason=? WHERE id=?",
        )
        .run(stage, now, reason, id);
    } else {
      this.db.prepare("UPDATE rules SET stage=? WHERE id=?").run(stage, id);
    }
  }

  // ---- shadow runs ----
  addShadowRun(r: Omit<ShadowRunRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO shadow_runs (rule_id,tool_type,timestamp,parity_score,tokens_full,tokens_pruned,notes)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        r.rule_id,
        r.tool_type,
        r.timestamp,
        r.parity_score,
        r.tokens_full,
        r.tokens_pruned,
        r.notes,
      );
  }

  recentShadowRuns(ruleId: string, limit: number): ShadowRunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM shadow_runs WHERE rule_id=? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(ruleId, limit) as unknown as ShadowRunRow[];
  }

  // ---- decisions / audit ----
  addDecision(d: Omit<DecisionRow, "id" | "timestamp">): void {
    this.db
      .prepare(
        "INSERT INTO decisions (timestamp,kind,rule_id,tool_type,tokens_saved,detail_json) VALUES (?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        d.kind,
        d.rule_id,
        d.tool_type,
        d.tokens_saved,
        d.detail_json,
      );
  }

  recentDecisions(limit = 20): DecisionRow[] {
    return this.db
      .prepare("SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as unknown as DecisionRow[];
  }

  totalTokensSaved(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(tokens_saved),0) AS s FROM decisions WHERE kind='prune'",
      )
      .get() as { s: number } | undefined;
    return row?.s ?? 0;
  }

  /** Total tokens processed (full, before pruning). */
  totalTokensProcessed(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(json_extract(detail_json,'$.tokensFull')),0) AS s FROM decisions WHERE kind='prune'",
      )
      .get() as { s: number } | undefined;
    return row?.s ?? 0;
  }

  /** Per-rule token stats: { saved, full, pruned, calls }. */
  ruleStats(ruleId: string): {
    saved: number;
    full: number;
    pruned: number;
    calls: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(tokens_saved),0) AS saved,
           COALESCE(SUM(json_extract(detail_json,'$.tokensFull')),0)  AS full,
           COALESCE(SUM(json_extract(detail_json,'$.tokensPruned')),0) AS pruned,
           COUNT(*) AS calls
         FROM decisions
         WHERE rule_id = ? AND kind='prune'`,
      )
      .get(ruleId) as
      | { saved: number; full: number; pruned: number; calls: number }
      | undefined;
    return row ?? { saved: 0, full: 0, pruned: 0, calls: 0 };
  }

  // ---- config snapshots ----
  saveConfigSnapshot(configJson: string, canaryClean: boolean): void {
    this.db
      .prepare(
        "INSERT INTO config_snapshots (timestamp,config_json,canary_clean) VALUES (?,?,?)",
      )
      .run(new Date().toISOString(), configJson, canaryClean ? 1 : 0);
  }

  lastCleanSnapshot(): ConfigSnapshotRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM config_snapshots WHERE canary_clean=1 ORDER BY id DESC LIMIT 1",
      )
      .get() as ConfigSnapshotRow | undefined;
  }

  // ---- memories (Layer 3: agent memory) ----

  /**
   * Save a memory with dedup and conflict detection.
   *
   * Dedup: if a memory with the same title (case-insensitive, trimmed) already
   * exists, return the existing id instead of creating a duplicate.
   *
   * Conflict detection: if a memory in the same category has a similar title
   * (shares a key word), the new memory is still saved but the caller can
   * check for conflicts via findMemoryConflicts().
   */
  saveMemory(opts: {
    category: string;
    title: string;
    body: string;
    tags: string[];
    source?: string;
  }): number {
    // Dedup: check for existing memory with same title (case-insensitive)
    const existing = this.db
      .prepare(
        "SELECT id FROM memories WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) LIMIT 1",
      )
      .get(opts.title) as { id: number } | undefined;
    if (existing) {
      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO memories (timestamp,category,title,body,tags_json,source,confidence)
         VALUES (?,?,?,?,?,?,1.0)`,
      )
      .run(
        new Date().toISOString(),
        opts.category,
        opts.title,
        opts.body,
        JSON.stringify(opts.tags),
        opts.source ?? null,
      );
    const id = Number(result.lastInsertRowid);
    // Sync FTS5 index (standalone table, no triggers)
    try {
      this.db
        .prepare(
          "INSERT INTO memories_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)",
        )
        .run(id, opts.title, opts.body, JSON.stringify(opts.tags));
    } catch {
      // FTS5 not available — recall will fall back to LIKE
    }
    return id;
  }

  /**
   * Find memories that potentially conflict with a given title + category.
   * Returns memories in the same category that share at least one significant
   * word with the title (excluding common stop words).
   */
  findMemoryConflicts(title: string, category: string): MemoryRow[] {
    const STOP_WORDS = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "can", "need", "use", "using", "used",
      "for", "with", "from", "into", "onto", "to", "in", "on", "at", "by",
      "of", "and", "or", "but", "not", "no", "yes", "this", "that", "these",
      "those", "it", "its", "as", "if", "then", "than", "so", "such", "too",
      "very", "also", "about", "how", "what", "when", "where", "why", "which",
    ]);
    const words = title
      .toLowerCase()
      .split(/[\s,.-]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (words.length === 0) return [];

    // Use FTS5 to find memories in the same category with matching words
    const ftsQuery = words.map((w) => w).join(" OR ");
    try {
      return this.db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts f ON f.rowid = m.id
           WHERE m.category = ? AND memories_fts MATCH ?
           ORDER BY f.rank
           LIMIT 5`,
        )
        .all(category, ftsQuery) as unknown as MemoryRow[];
    } catch {
      // FTS5 not available or query syntax issue — fallback to LIKE
      const conditions = words.map(() => "title LIKE ?").join(" OR ");
      const params = words.map((w) => `%${w}%`);
      return this.db
        .prepare(
          `SELECT * FROM memories WHERE category = ? AND (${conditions}) LIMIT 5`,
        )
        .all(category, ...params) as unknown as MemoryRow[];
    }
  }

  /**
   * Recall memories using FTS5 full-text search with relevance ranking.
   * Falls back to LIKE-based search if FTS5 is unavailable.
   *
   * Results are ranked by FTS5 relevance score, then by access recency.
   */
  recallMemories(query: string, limit = 10): MemoryRow[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return this.listMemories(limit);
    }

    // Try FTS5 first — tokenized, ranked, porter-stemmed search
    try {
      // FTS5 MATCH query: support multi-word queries with OR logic
      // Escape special FTS5 characters by quoting each word
      const ftsQuery = trimmed
        .split(/[\s,]+/)
        .filter((w) => w.length >= 2)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(" OR ");

      if (ftsQuery.length === 0) {
        return this.listMemories(limit);
      }

      return this.db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts f ON f.rowid = m.id
           WHERE memories_fts MATCH ?
           ORDER BY f.rank, m.accessed_at IS NULL, m.accessed_at DESC, m.timestamp DESC
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as unknown as MemoryRow[];
    } catch (ftsErr) {
      // FTS5 failed — log and fall back to LIKE-based search
      logger.warn("FTS5 recall failed, falling back to LIKE", {
        err: String(ftsErr),
      });
      const words = trimmed
        .split(/[\s,]+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2)
        .map((w) => `%${w}%`);

      if (words.length === 0) {
        return this.listMemories(limit);
      }

      const conditions: string[] = [];
      const params: (string | number)[] = [];
      for (const word of words) {
        conditions.push("title LIKE ? OR body LIKE ? OR tags_json LIKE ?");
        params.push(word, word, word);
      }
      params.push(limit);

      return this.db
        .prepare(
          `SELECT * FROM memories
           WHERE ${conditions.join(" OR ")}
           ORDER BY accessed_at IS NULL, accessed_at DESC, timestamp DESC
           LIMIT ?`,
        )
        .all(...params) as unknown as MemoryRow[];
    }
  }

  listMemories(limit = 50): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as unknown as MemoryRow[];
  }

  touchMemory(id: number): void {
    this.db
      .prepare(
        "UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  forgetMemory(id: number): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    // Sync FTS5 index (standalone table, no triggers)
    if (Number(result.changes) > 0) {
      try {
        this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(id);
      } catch {
        // FTS5 not available — non-fatal
      }
    }
    return Number(result.changes) > 0;
  }

  // ---- context selections (Layer 1: input context) ----

  saveContextSelection(opts: {
    task: string;
    files: string[];
    reasoning?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO context_selections (timestamp,task,files_json,reasoning) VALUES (?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        opts.task,
        JSON.stringify(opts.files),
        opts.reasoning ?? null,
      );
  }

  recentContextSelections(limit = 10): ContextSelectionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM context_selections ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit) as unknown as ContextSelectionRow[];
  }

  // ---- task outcomes (verification upgrade) ----

  recordTaskOutcome(opts: {
    task: string;
    success: boolean;
    pruned: boolean;
    tokensSaved?: number;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_outcomes (timestamp,task,success,pruned,tokens_saved,detail_json)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        opts.task,
        opts.success ? 1 : 0,
        opts.pruned ? 1 : 0,
        opts.tokensSaved ?? 0,
        JSON.stringify(opts.detail ?? {}),
      );
  }

  taskOutcomeStats(): {
    total: number;
    successRate: number;
    prunedSuccessRate: number;
    rawSuccessRate: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successes,
           COALESCE(SUM(CASE WHEN pruned=1 AND success=1 THEN 1 ELSE 0 END),0) AS pruned_successes,
           COALESCE(SUM(CASE WHEN pruned=1 THEN 1 ELSE 0 END),0) AS pruned_total,
           COALESCE(SUM(CASE WHEN pruned=0 AND success=1 THEN 1 ELSE 0 END),0) AS raw_successes,
           COALESCE(SUM(CASE WHEN pruned=0 THEN 1 ELSE 0 END),0) AS raw_total
         FROM task_outcomes`,
      )
      .get() as
      | {
          total: number;
          successes: number;
          pruned_successes: number;
          pruned_total: number;
          raw_successes: number;
          raw_total: number;
        }
      | undefined;

    if (!row || row.total === 0) {
      return {
        total: 0,
        successRate: 0,
        prunedSuccessRate: 0,
        rawSuccessRate: 0,
      };
    }
    return {
      total: row.total,
      successRate: row.successes / row.total,
      prunedSuccessRate:
        row.pruned_total > 0 ? row.pruned_successes / row.pruned_total : 0,
      rawSuccessRate: row.raw_total > 0 ? row.raw_successes / row.raw_total : 0,
    };
  }

  // ---- CCR (Compress-Cache-Retrieve): reversible pruning ----

  /** Store an original tool output with a hash key for later retrieval. */
  saveCcr(opts: {
    hash: string;
    rawOutput: string;
    toolType: string;
    ruleId: string;
    tokensFull: number;
    tokensPruned: number;
  }): void {
    // Upsert by hash. Use ON CONFLICT (not INSERT OR REPLACE) so that re-caching
    // an identical output doesn't wipe the accessed_at / access_count columns,
    // which INSERT OR REPLACE would reset by deleting and re-inserting the row.
    this.db
      .prepare(
        `INSERT INTO ccr_cache
           (hash, raw_output, tool_type, rule_id, tokens_full, tokens_pruned, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(hash) DO UPDATE SET
           raw_output = excluded.raw_output,
           tool_type = excluded.tool_type,
           rule_id = excluded.rule_id,
           tokens_full = excluded.tokens_full,
           tokens_pruned = excluded.tokens_pruned,
           created_at = excluded.created_at`,
      )
      .run(
        opts.hash,
        opts.rawOutput,
        opts.toolType,
        opts.ruleId,
        opts.tokensFull,
        opts.tokensPruned,
        new Date().toISOString(),
      );
  }

  /** Retrieve an original tool output by hash. Returns undefined if not found. */
  getCcr(hash: string): CcrRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM ccr_cache WHERE hash = ?")
      .get(hash) as CcrRow | undefined;
    if (row) {
      this.db
        .prepare(
          "UPDATE ccr_cache SET accessed_at = ?, access_count = access_count + 1 WHERE hash = ?",
        )
        .run(new Date().toISOString(), hash);
    }
    return row;
  }

  /** Count of cached originals. */
  ccrCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM ccr_cache")
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Total tokens saved by CCR (sum of tokens_full - tokens_pruned). */
  ccrTokensSaved(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(tokens_full - tokens_pruned), 0) AS s FROM ccr_cache",
      )
      .get() as { s: number } | undefined;
    return row?.s ?? 0;
  }

  /** Delete CCR entries older than the given number of days. */
  ccrCleanup(maxAgeDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const result = this.db
      .prepare("DELETE FROM ccr_cache WHERE created_at < ?")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}

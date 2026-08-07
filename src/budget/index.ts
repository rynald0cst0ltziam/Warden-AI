/**
 * Budget caps — enforce per-seat and per-project token spend limits.
 *
 * Tracks token spend per scope (seat/project) and logs alerts when caps
 * are exceeded. Uses a global SQLite database to ensure atomic writes and
 * prevent data corruption when multiple agents run concurrently.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import type { DatabaseSync } from "../store/sqlite-loader.js";
import { logger } from "../logging/index.js";

// Load node:sqlite synchronously via createRequire with a runtime-built
// specifier. This prevents esbuild from stripping the `node:` prefix to a
// bare `sqlite` specifier (which Node can't resolve).
const _require = createRequire(import.meta.url);
const _sqliteSpec = "node" + ":sqlite";
const _sqlite = _require(_sqliteSpec) as typeof import("node:sqlite");
const DatabaseSyncCtor = _sqlite.DatabaseSync;

export interface BudgetCap {
  scope: string;
  capTokens: number;
  periodDays: number;
}

export interface BudgetUsage {
  scope: string;
  spent: number;
  cap: number;
  periodStart: string;
  exceeded: boolean;
}

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (_db) return _db;
  const dir = join(homedir(), ".warden");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  
  _db = new DatabaseSyncCtor(join(dir, "budgets.db"));
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS budget_caps (
      scope TEXT PRIMARY KEY,
      cap_tokens INTEGER NOT NULL,
      period_days INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS budget_usage (
      scope TEXT PRIMARY KEY,
      spent INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      alerted INTEGER NOT NULL DEFAULT 0
    );
  `);
  return _db;
}

/** Set or update a budget cap for a scope. */
export function setBudgetCap(
  scope: string,
  capTokens: number,
  periodDays = 30,
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO budget_caps (scope, cap_tokens, period_days)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      cap_tokens = excluded.cap_tokens,
      period_days = excluded.period_days
  `);
  stmt.run(scope, capTokens, periodDays);
  logger.info("budget cap set", { scope, capTokens, periodDays });
}

/** Remove a budget cap. */
export function removeBudgetCap(scope: string): void {
  const db = getDb();
  db.prepare("DELETE FROM budget_caps WHERE scope = ?").run(scope);
  db.prepare("DELETE FROM budget_usage WHERE scope = ?").run(scope);
}

/** List all configured budget caps. */
export function listBudgetCaps(): BudgetCap[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM budget_caps").all() as any[];
  return rows.map((r) => ({
    scope: r.scope,
    capTokens: r.cap_tokens,
    periodDays: r.period_days,
  }));
}

/** Check if a period has rolled over and reset usage if so. */
function maybeResetPeriod(db: DatabaseSync, scope: string, periodDays: number): void {
  const usage = db.prepare("SELECT * FROM budget_usage WHERE scope = ?").get(scope) as any;
  if (!usage) return;
  
  const periodMs = periodDays * 86_400_000;
  const elapsed = Date.now() - new Date(usage.period_start).getTime();
  
  if (elapsed > periodMs) {
    db.prepare(`
      UPDATE budget_usage 
      SET spent = 0, period_start = ?, alerted = 0 
      WHERE scope = ?
    `).run(new Date().toISOString(), scope);
  }
}

/**
 * Record token spend for a scope and check against caps.
 * Returns the updated usage, or null if no cap is configured for this scope.
 */
export async function recordSpend(
  scope: string,
  tokens: number,
): Promise<BudgetUsage | null> {
  // Use synchronous db calls (WAL mode makes this extremely fast and safe)
  const db = getDb();
  
  db.exec("BEGIN IMMEDIATE");
  try {
    const capRow = db.prepare("SELECT * FROM budget_caps WHERE scope = ?").get(scope) as any;
    if (!capRow) {
      db.exec("ROLLBACK");
      return null;
    }
    
    maybeResetPeriod(db, scope, capRow.period_days);
    
    // Insert or update usage
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO budget_usage (scope, spent, period_start, alerted)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(scope) DO UPDATE SET spent = spent + ?
    `).run(scope, tokens, now, tokens);
    
    const usage = db.prepare("SELECT * FROM budget_usage WHERE scope = ?").get(scope) as any;
    const exceeded = usage.spent > capRow.cap_tokens;
    
    if (exceeded && usage.alerted === 0) {
      db.prepare("UPDATE budget_usage SET alerted = 1 WHERE scope = ?").run(scope);
      logger.warn("budget cap exceeded", {
        scope,
        spent: usage.spent,
        cap: capRow.cap_tokens,
      });
    }
    
    db.exec("COMMIT");
    
    return {
      scope,
      spent: usage.spent,
      cap: capRow.cap_tokens,
      periodStart: usage.period_start,
      exceeded,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Get current usage for all scopes with caps. */
export function budgetReport(): BudgetUsage[] {
  const db = getDb();
  const caps = db.prepare("SELECT * FROM budget_caps").all() as any[];
  
  return caps.map((cap) => {
    db.exec("BEGIN IMMEDIATE");
    maybeResetPeriod(db, cap.scope, cap.period_days);
    const usage = db.prepare("SELECT * FROM budget_usage WHERE scope = ?").get(cap.scope) as any;
    db.exec("COMMIT");
    
    return {
      scope: cap.scope,
      spent: usage?.spent ?? 0,
      cap: cap.cap_tokens,
      periodStart: usage?.period_start ?? new Date().toISOString(),
      exceeded: (usage?.spent ?? 0) > cap.cap_tokens,
    };
  });
}

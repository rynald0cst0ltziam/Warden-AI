/**
 * Global stats — aggregates across all project databases.
 *
 * Each project has its own .warden/warden.db. This module scans for all
 * known project DBs and aggregates stats so the dashboard/HUD/CLI can show
 * both per-project and overall numbers.
 *
 * Project DBs are discovered from the global registry at ~/.warden/projects.json
 * which is updated whenever a project DB is created or opened.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { loadSqlite, type DatabaseSync } from "../store/sqlite-loader.js";
import { logger } from "../logging/index.js";

export interface ProjectStats {
  projectPath: string;
  projectName: string;
  dbPath: string;
  tokensSaved: number;
  tokensProcessed: number;
  reductionPct: number;
  rulesActive: number;
  rulesShadow: number;
  rulesReverted: number;
  memoriesCount: number;
  outcomesCount: number;
  successRate: number;
  lastActivity: string | null;
}

export interface TimeBreakdown {
  tokensSaved: number;
  tokensProcessed: number;
  reductionPct: number;
  calls: number;
}

export interface GlobalStats {
  totalTokensSaved: number;
  totalTokensProcessed: number;
  overallReductionPct: number;
  projectCount: number;
  totalRulesActive: number;
  totalRulesShadow: number;
  totalMemories: number;
  totalOutcomes: number;
  overallSuccessRate: number;
  projects: ProjectStats[];
  // Time-based breakdowns (across all projects)
  today: TimeBreakdown;
  last7days: TimeBreakdown;
  allTime: TimeBreakdown;
}

interface Registry {
  projects: Array<{ path: string; dbPath: string; firstSeen: string }>;
  lastUpdated: string;
}

/** Path to the global project registry. */
function registryPath(): string {
  const dir = join(homedir(), ".warden");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "projects.json");
}

/** Register a project in the global registry. Called when a project DB is opened. */
export function registerProject(projectPath: string, dbPath: string): void {
  try {
    const regPath = registryPath();
    const registry = readRegistry();
    const normalized = projectPath.replace(/\\/g, "/");
    const dbNorm = dbPath.replace(/\\/g, "/");
    const existing = registry.projects.find((p) => p.path === normalized);
    if (existing) {
      existing.dbPath = dbNorm;
    } else {
      registry.projects.push({
        path: normalized,
        dbPath: dbNorm,
        firstSeen: new Date().toISOString(),
      });
    }
    registry.lastUpdated = new Date().toISOString();
    writeFileSync(regPath, JSON.stringify(registry, null, 2), "utf8");
  } catch (e) {
    logger.debug("failed to register project", { error: String(e) });
  }
}

function readRegistry(): Registry {
  try {
    const regPath = registryPath();
    if (existsSync(regPath)) {
      return JSON.parse(readFileSync(regPath, "utf8")) as Registry;
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return { projects: [], lastUpdated: new Date().toISOString() };
}

/** Collect stats from a single project DB. */
function collectProjectStats(
  projectPath: string,
  dbPath: string,
  db: DatabaseSync,
): ProjectStats {
  const projectName = basename(projectPath);

  let tokensSaved = 0;
  let tokensProcessed = 0;
  try {
    // Match the queries used by SqliteStore.totalTokensSaved / totalTokensProcessed
    const row = db.prepare(
      "SELECT COALESCE(SUM(tokens_saved),0) as saved, " +
      "COALESCE(SUM(json_extract(detail_json,'$.tokensFull')),0) as full " +
      "FROM decisions WHERE kind='prune'"
    ).get() as { saved: number; full: number } | undefined;
    tokensSaved = row?.saved ?? 0;
    tokensProcessed = row?.full ?? 0;
  } catch { /* table might not exist yet */ }

  let rulesActive = 0, rulesShadow = 0, rulesReverted = 0;
  try {
    const rules = db.prepare("SELECT stage FROM rules").all() as Array<{ stage: string }>;
    for (const r of rules) {
      if (r.stage === "active") rulesActive++;
      else if (r.stage === "shadow") rulesShadow++;
      else if (r.stage === "reverted") rulesReverted++;
    }
  } catch { /* table might not exist */ }

  let memoriesCount = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number } | undefined;
    memoriesCount = row?.cnt ?? 0;
  } catch { /* table might not exist */ }

  let outcomesCount = 0, successRate = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) as wins FROM task_outcomes").get() as { total: number; wins: number } | undefined;
    outcomesCount = row?.total ?? 0;
    successRate = outcomesCount > 0 ? Math.round(((row?.wins ?? 0) / outcomesCount) * 100) : 0;
  } catch { /* table might not exist */ }

  let lastActivity: string | null = null;
  try {
    const row = db.prepare("SELECT MAX(timestamp) as last FROM decisions").get() as { last: string | null } | undefined;
    lastActivity = row?.last ?? null;
  } catch { /* table might not exist */ }

  return {
    projectPath,
    projectName,
    dbPath,
    tokensSaved,
    tokensProcessed,
    reductionPct: tokensProcessed > 0 ? Math.round((tokensSaved / tokensProcessed) * 100) : 0,
    rulesActive,
    rulesShadow,
    rulesReverted,
    memoriesCount,
    outcomesCount,
    successRate,
    lastActivity,
  };
}

/** Collect time-bucketed stats from a single project DB. */
function collectTimeStats(db: DatabaseSync, sinceIso: string): TimeBreakdown {
  let tokensSaved = 0, tokensProcessed = 0, calls = 0;
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(tokens_saved),0) as saved, " +
      "COALESCE(SUM(json_extract(detail_json,'$.tokensFull')),0) as full, " +
      "COUNT(*) as cnt " +
      "FROM decisions WHERE kind='prune' AND timestamp >= ?"
    ).get(sinceIso) as { saved: number; full: number; cnt: number } | undefined;
    tokensSaved = row?.saved ?? 0;
    tokensProcessed = row?.full ?? 0;
    calls = row?.cnt ?? 0;
  } catch { /* table might not exist */ }
  return {
    tokensSaved,
    tokensProcessed,
    reductionPct: tokensProcessed > 0 ? Math.round((tokensSaved / tokensProcessed) * 100) : 0,
    calls,
  };
}

/** Collect global stats across all known project DBs. */
export async function collectGlobalStats(): Promise<GlobalStats> {
  const registry = readRegistry();
  const { DatabaseSync } = await loadSqlite();
  const projects: ProjectStats[] = [];

  // Time thresholds
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const epoch = "2000-01-01T00:00:00.000Z";

  // Aggregate time stats across all projects
  let todaySaved = 0, todayProcessed = 0, todayCalls = 0;
  let weekSaved = 0, weekProcessed = 0, weekCalls = 0;
  let allSaved = 0, allProcessed = 0, allCalls = 0;

  for (const entry of registry.projects) {
    const dbPath = entry.dbPath.replace(/\//g, "\\");
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const stats = collectProjectStats(entry.path, dbPath, db);

      // Time-based stats
      const today = collectTimeStats(db, todayStart);
      const week = collectTimeStats(db, sevenDaysAgo);
      const allTime = collectTimeStats(db, epoch);
      todaySaved += today.tokensSaved; todayProcessed += today.tokensProcessed; todayCalls += today.calls;
      weekSaved += week.tokensSaved; weekProcessed += week.tokensProcessed; weekCalls += week.calls;
      allSaved += allTime.tokensSaved; allProcessed += allTime.tokensProcessed; allCalls += allTime.calls;

      db.close();
      projects.push(stats);
    } catch (e) {
      logger.debug("failed to open project db", { dbPath, error: String(e) });
    }
  }

  // Sort: most tokens saved first
  projects.sort((a, b) => b.tokensSaved - a.tokensSaved);

  const totalTokensSaved = projects.reduce((sum, p) => sum + p.tokensSaved, 0);
  const totalTokensProcessed = projects.reduce((sum, p) => sum + p.tokensProcessed, 0);
  const totalRulesActive = projects.reduce((sum, p) => sum + p.rulesActive, 0);
  const totalRulesShadow = projects.reduce((sum, p) => sum + p.rulesShadow, 0);
  const totalMemories = projects.reduce((sum, p) => sum + p.memoriesCount, 0);
  const totalOutcomes = projects.reduce((sum, p) => sum + p.outcomesCount, 0);
  const totalSuccesses = projects.reduce(
    (sum, p) => sum + Math.round((p.successRate / 100) * p.outcomesCount), 0
  );

  const mkTime = (saved: number, processed: number, calls: number): TimeBreakdown => ({
    tokensSaved: saved,
    tokensProcessed: processed,
    reductionPct: processed > 0 ? Math.round((saved / processed) * 100) : 0,
    calls,
  });

  return {
    totalTokensSaved,
    totalTokensProcessed,
    overallReductionPct: totalTokensProcessed > 0 ? Math.round((totalTokensSaved / totalTokensProcessed) * 100) : 0,
    projectCount: projects.length,
    totalRulesActive,
    totalRulesShadow,
    totalMemories,
    totalOutcomes,
    overallSuccessRate: totalOutcomes > 0 ? Math.round((totalSuccesses / totalOutcomes) * 100) : 0,
    projects,
    today: mkTime(todaySaved, todayProcessed, todayCalls),
    last7days: mkTime(weekSaved, weekProcessed, weekCalls),
    allTime: mkTime(allSaved, allProcessed, allCalls),
  };
}

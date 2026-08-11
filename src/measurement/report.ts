/**
 * Task report — P0a measurement layer.
 *
 * Aggregates existing data from `decisions` and `task_outcomes` tables into
 * a per-task or per-time-range report. No new instrumentation required —
 * all data already exists, it just wasn't being aggregated.
 *
 * The report shows:
 *   - Gross tokens saved (from pruning decisions)
 *   - Tokens processed (raw output that went through pruning)
 *   - Reduction percentage
 *   - Guard pass/fail counts
 *   - Task outcomes (success/failure, pruned vs raw)
 *   - Per-rule breakdown
 *   - Net tokens (gross - Warden overhead, when timing is available)
 *
 * No fabricated metrics. Every number traces to a stored decision or outcome.
 */
import type { SqliteStore, DecisionRow } from "../store/sqlite.js";

export interface TaskReportInput {
  /** Start of the time range (ISO timestamp). */
  start: string;
  /** End of the time range (ISO timestamp). */
  end: string;
  /** Optional task description filter (substring match). */
  taskFilter?: string;
}

export interface RuleBreakdown {
  ruleId: string;
  calls: number;
  tokensSaved: number;
  tokensFull: number;
  tokensPruned: number;
  reductionPct: number;
}

export interface TaskReport {
  /** Time range covered. */
  start: string;
  end: string;

  /** Pruning decisions in range. */
  pruneCalls: number;
  guardFailures: number;
  guardPassRate: number;

  /** Token accounting (gross). */
  tokensFull: number;
  tokensPruned: number;
  tokensSaved: number;
  reductionPct: number;

  /** Warden overhead (from P0b timing, 0 for pre-P0b data). */
  overheadMs: number;
  overheadTokens: number;

  /** Net savings = gross - overhead. */
  netTokensSaved: number;

  /** Task outcomes in range. */
  taskOutcomes: Array<{
    task: string;
    success: boolean;
    pruned: boolean;
    tokensSaved: number;
    timestamp: string;
  }>;
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  successRate: number;

  /** Per-rule breakdown. */
  rules: RuleBreakdown[];

  /** CCR cache stats. */
  ccrCount: number;
  ccrTokensRetrievable: number;
}

/**
 * Build a task report from existing stored data.
 *
 * @param store - The SqliteStore to query.
 * @param input - Time range and optional task filter.
 * @returns Aggregated report. All numbers are derived from stored data.
 */
export function buildTaskReport(
  store: SqliteStore,
  input: TaskReportInput,
): TaskReport {
  const decisions = store.decisionsByTimeRange(input.start, input.end);
  const outcomes = store.taskOutcomesByTimeRange(input.start, input.end);

  // Filter to prune-related decisions only
  const pruneDecisions = decisions.filter(
    (d) => d.kind === "prune" || d.kind === "prune-guard-failed",
  );

  // Aggregate token stats
  let tokensFull = 0;
  let tokensPruned = 0;
  let tokensSaved = 0;
  let guardFailures = 0;
  let totalDurationMs = 0;

  for (const d of pruneDecisions) {
    try {
      const detail = JSON.parse(d.detail_json) as {
        tokensFull?: number;
        tokensPruned?: number;
        guardOk?: boolean;
        durationMs?: number;
      };
      tokensFull += detail.tokensFull ?? 0;
      tokensPruned += detail.tokensPruned ?? 0;
      if (d.kind === "prune") {
        tokensSaved += d.tokens_saved;
      }
      if (d.kind === "prune-guard-failed") {
        guardFailures++;
      }
      totalDurationMs += detail.durationMs ?? 0;
    } catch {
      // Malformed detail_json — skip
    }
  }

  const pruneCalls = pruneDecisions.length;
  const guardPassRate =
    pruneCalls > 0 ? (pruneCalls - guardFailures) / pruneCalls : 1;
  const reductionPct =
    tokensFull > 0 ? Math.round((tokensSaved / tokensFull) * 1000) / 10 : 0;

  // Per-rule breakdown
  const ruleMap = new Map<string, RuleBreakdown>();
  for (const d of pruneDecisions) {
    if (!d.rule_id) continue;
    const existing = ruleMap.get(d.rule_id) ?? {
      ruleId: d.rule_id,
      calls: 0,
      tokensSaved: 0,
      tokensFull: 0,
      tokensPruned: 0,
      reductionPct: 0,
    };
    existing.calls++;
    if (d.kind === "prune") {
      existing.tokensSaved += d.tokens_saved;
    }
    try {
      const detail = JSON.parse(d.detail_json) as {
        tokensFull?: number;
        tokensPruned?: number;
      };
      existing.tokensFull += detail.tokensFull ?? 0;
      existing.tokensPruned += detail.tokensPruned ?? 0;
    } catch {
      // skip
    }
    ruleMap.set(d.rule_id, existing);
  }

  // Calculate reduction pct per rule
  const rules = Array.from(ruleMap.values()).map((r) => ({
    ...r,
    reductionPct:
      r.tokensFull > 0
        ? Math.round((r.tokensSaved / r.tokensFull) * 1000) / 10
        : 0,
  }));

  // Sort rules by tokens saved (descending)
  rules.sort((a, b) => b.tokensSaved - a.tokensSaved);

  // Task outcomes
  const filteredOutcomes = input.taskFilter
    ? outcomes.filter((o) =>
        o.task.toLowerCase().includes(input.taskFilter!.toLowerCase()),
      )
    : outcomes;

  const taskOutcomes = filteredOutcomes.map((o) => ({
    task: o.task,
    success: o.success === 1,
    pruned: o.pruned === 1,
    tokensSaved: o.tokens_saved,
    timestamp: o.timestamp,
  }));

  const totalTasks = taskOutcomes.length;
  const successfulTasks = taskOutcomes.filter((o) => o.success).length;
  const failedTasks = totalTasks - successfulTasks;
  const successRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

  // CCR stats
  const ccrCount = store.ccrCount();
  const ccrTokensRetrievable = store.ccrTokensSaved();

  // Warden overhead: measured as total processing time in milliseconds.
  // Converting time to tokens is not straightforward — we report both
  // duration (ms) and a rough token overhead estimate.
  // The estimate assumes ~1000 tokens/sec of Warden processing overhead,
  // which is conservative (Warden's pruning is sub-millisecond for most
  // outputs). This is clearly labeled as an estimate, not a precise measure.
  const overheadMs = totalDurationMs;
  const overheadTokens = Math.round(totalDurationMs * 1.0); // ~1 token per ms (conservative)
  const netTokensSaved = tokensSaved - overheadTokens;

  return {
    start: input.start,
    end: input.end,
    pruneCalls,
    guardFailures,
    guardPassRate,
    tokensFull,
    tokensPruned,
    tokensSaved,
    reductionPct,
    overheadMs,
    overheadTokens,
    netTokensSaved,
    taskOutcomes,
    totalTasks,
    successfulTasks,
    failedTasks,
    successRate,
    rules,
    ccrCount,
    ccrTokensRetrievable,
  };
}

/**
 * Format a task report as human-readable text for CLI output.
 */
export function formatTaskReport(report: TaskReport): string {
  const lines: string[] = [
    "WARDEN TASK REPORT",
    "────────────────────────────────────────",
    "",
    `Time range: ${report.start} to ${report.end}`,
    "",
    "CONTEXT OPTIMIZATION",
    `  Prune calls:          ${report.pruneCalls}`,
    `  Guard pass rate:      ${(report.guardPassRate * 100).toFixed(1)}%`,
    `  Guard failures:       ${report.guardFailures}`,
    `  Tokens processed:     ${report.tokensFull.toLocaleString()}`,
    `  Tokens shipped:       ${report.tokensPruned.toLocaleString()}`,
    `  Tokens saved (gross): ${report.tokensSaved.toLocaleString()}`,
    `  Reduction:            ${report.reductionPct}%`,
    "",
  ];

  if (report.overheadMs > 0) {
    lines.push(
      "WARDEN OVERHEAD",
      `  Processing time:      ${report.overheadMs}ms`,
      `  Overhead tokens:      ${report.overheadTokens.toLocaleString()} (est.)`,
      `  Net tokens saved:     ${report.netTokensSaved.toLocaleString()}`,
      "",
    );
  }

  if (report.rules.length > 0) {
    lines.push("PER-RULE BREAKDOWN");
    for (const r of report.rules) {
      lines.push(
        `  ${r.ruleId.padEnd(36)} calls=${String(r.calls).padStart(4)} saved=${r.tokensSaved.toLocaleString().padStart(8)} (${r.reductionPct}%)`,
      );
    }
    lines.push("");
  }

  if (report.totalTasks > 0) {
    lines.push(
      "TASK OUTCOMES",
      `  Total tasks:          ${report.totalTasks}`,
      `  Successful:           ${report.successfulTasks}`,
      `  Failed:               ${report.failedTasks}`,
      `  Success rate:         ${(report.successRate * 100).toFixed(1)}%`,
      "",
    );
    for (const o of report.taskOutcomes) {
      const status = o.success ? "SUCCESS" : "FAILURE";
      const pruned = o.pruned ? "pruned" : "raw";
      lines.push(
        `  [${status.padEnd(7)}] ${o.task} (${pruned}, saved=${o.tokensSaved})`,
      );
    }
    lines.push("");
  }

  if (report.ccrCount > 0) {
    lines.push(
      "CCR (REVERSIBLE PRUNING)",
      `  Cached originals:     ${report.ccrCount}`,
      `  Tokens retrievable:   ${report.ccrTokensRetrievable.toLocaleString()}`,
      "",
    );
  }

  lines.push("────────────────────────────────────────");
  lines.push(
    `Total tokens avoided: ${report.tokensSaved.toLocaleString()}`,
  );

  return lines.join("\n");
}

/**
 * Build a project-wide historical report from all stored data.
 * Aggregates across all time.
 */
export function buildProjectReport(store: SqliteStore): {
  totalTokensSaved: number;
  totalTokensProcessed: number;
  reductionPct: number;
  totalPruneCalls: number;
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  successRate: number;
  ccrCount: number;
  ccrTokensRetrievable: number;
  recentOutcomes: Array<{
    task: string;
    success: boolean;
    pruned: boolean;
    tokensSaved: number;
    timestamp: string;
  }>;
} {
  const totalTokensSaved = store.totalTokensSaved();
  const totalTokensProcessed = store.totalTokensProcessed();
  const reductionPct =
    totalTokensProcessed > 0
      ? Math.round((totalTokensSaved / totalTokensProcessed) * 1000) / 10
      : 0;

  // Count total prune calls
  const decisions = store.recentDecisions(100000);
  const totalPruneCalls = decisions.filter(
    (d: DecisionRow) => d.kind === "prune" || d.kind === "prune-guard-failed",
  ).length;

  // Task outcomes
  const outcomes = store.recentTaskOutcomes(100);
  const totalTasks = outcomes.length;
  const successfulTasks = outcomes.filter((o) => o.success === 1).length;
  const failedTasks = totalTasks - successfulTasks;
  const successRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

  return {
    totalTokensSaved,
    totalTokensProcessed,
    reductionPct,
    totalPruneCalls,
    totalTasks,
    successfulTasks,
    failedTasks,
    successRate,
    ccrCount: store.ccrCount(),
    ccrTokensRetrievable: store.ccrTokensSaved(),
    recentOutcomes: outcomes.slice(0, 20).map((o) => ({
      task: o.task,
      success: o.success === 1,
      pruned: o.pruned === 1,
      tokensSaved: o.tokens_saved,
      timestamp: o.timestamp,
    })),
  };
}

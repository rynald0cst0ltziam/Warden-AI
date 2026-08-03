/**
 * Terminal HUD — the ambient trust signal while coding.
 *
 * Renders a compact one-screen dashboard with six sections:
 *   1. Header — project, tokens saved, reduction %, health indicator
 *   2. Global summary — all-projects totals, time breakdown, top projects
 *   3. Rules table — every rule's stage, confidence, savings, calls
 *   4. System status — outcomes, CCR cache, budget, index, memory, guard
 *   5. Recent decisions — audit trail of recent prune/promote/revert actions
 *   6. Recent memories — last few saved decisions
 *
 * Two modes:
 *   - `renderOnce()`  — print a single snapshot and exit (used by `warden status`)
 *   - `renderLive()`  — refresh every `intervalMs` until Ctrl+C (used by `warden hud`)
 *
 * Uses chalk for ANSI coloring. All output goes to stdout (this is a CLI
 * command, not the MCP server, so stdout is fine).
 */
import chalk from "chalk";
import type { Warden } from "../warden.js";
import type { RuleStage } from "../store/sqlite.js";
import { collectGlobalStats, type GlobalStats } from "../stats/global.js";
import { ccrSummary } from "../ccr/index.js";
import { budgetReport } from "../budget/index.js";
import { CodeIndex } from "../index/indexer.js";

const STAGE_COLOR: Record<RuleStage, (s: string) => string> = {
  shadow: chalk.gray,
  canary: chalk.yellow,
  active: chalk.green,
  reverted: chalk.red,
};

function bar(confidence: number): string {
  const width = 10;
  const filled = Math.round(confidence * width);
  return chalk.cyan(
    "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]",
  );
}

/** Overall health indicator — green/yellow/red based on rule stages + guard. */
function healthIndicator(warden: Warden): string {
  const status = warden.status();
  const reverted = status.filter((s) => s.stage === "reverted").length;
  const decaying = status.filter((s) => s.decaying).length;
  const active = status.filter((s) => s.stage === "active").length;
  const total = status.length;

  if (reverted > 0) {
    return chalk.red.bold("● DEGRADED");
  }
  if (decaying > 0 || active === 0) {
    return chalk.yellow.bold("● ATTENTION");
  }
  return chalk.green.bold("● HEALTHY");
}

function header(warden: Warden): string {
  const saved = warden.totalTokensSaved();
  const processed = warden.totalTokensProcessed();
  const pct = processed > 0 ? Math.round((saved / processed) * 100) : 0;
  const activeRules = warden
    .status()
    .filter((s) => s.stage === "active").length;
  const totalRules = warden.status().length;
  const projectName = warden.repoRoot
    ? warden.repoRoot.split(/[/\\]/).pop() || "unknown"
    : "global";
  const health = healthIndicator(warden);
  return [
    "",
    chalk.bold.cyan("  warden") +
      chalk.gray(" — structurally-verified context layer") +
      chalk.gray(` — project: ${projectName}`) +
      "  " +
      health,
    chalk.gray(
      "  ────────────────────────────────────────────────────────────────────────",
    ),
    `  ${chalk.bold("tokens saved:")} ${chalk.green(String(saved))} ${chalk.gray(`(${pct}% reduction)`)}  ${chalk.bold("processed:")} ${chalk.gray(String(processed))}  ${chalk.bold("rules:")} ${chalk.green(String(activeRules))}/${chalk.gray(String(totalRules))} active`,
    "",
  ].join("\n");
}

function globalSummary(global: GlobalStats): string {
  const lines = [
    chalk.gray(
      `  all projects: ${global.totalTokensSaved.toLocaleString()} tokens saved (${global.overallReductionPct}% overall) — ${global.projectCount} project(s)`,
    ),
  ];
  // Time breakdown
  if (global.today && global.last7days) {
    lines.push(
      chalk.gray(
        `  today: ${global.today.tokensSaved.toLocaleString()} saved (${global.today.reductionPct}%, ${global.today.calls} calls)  |  7d: ${global.last7days.tokensSaved.toLocaleString()} (${global.last7days.reductionPct}%, ${global.last7days.calls} calls)`,
      ),
    );
  }
  lines.push("");
  // Show top 5 projects
  const top = global.projects.slice(0, 5);
  if (top.length > 1) {
    lines.push(chalk.gray("  top projects:"));
    for (const p of top) {
      lines.push(
        chalk.gray(
          `    ${p.projectName.padEnd(20)} ${String(p.tokensSaved).padStart(8)} saved  ${p.reductionPct}%  ${p.rulesActive}/${p.rulesShadow} rules  ${p.memoriesCount} memories`,
        ),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function rulesTable(warden: Warden): string {
  const status = warden.status();
  if (status.length === 0) {
    return chalk.gray("  (no rules registered yet — run `warden init`)");
  }
  const lines = [
    `  ${"rule".padEnd(38)} ${"stage".padEnd(9)} ${"confidence".padEnd(14)} ${"saved".padEnd(12)} ${"calls".padEnd(6)}`,
    `  ${"─".repeat(38)} ${"─".repeat(9)} ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(6)}`,
  ];
  for (const s of status) {
    const stage = STAGE_COLOR[s.stage](s.stage.padEnd(8));
    const conf = `${bar(s.confidence)} ${s.confidence.toFixed(2)}${s.decaying ? chalk.red(" ⚠") : ""}`;
    const pct =
      s.tokensFull > 0 ? Math.round((s.tokensSaved / s.tokensFull) * 100) : 0;
    const savedStr =
      s.tokensSaved > 0
        ? chalk.green(`${s.tokensSaved} (${pct}%)`)
        : chalk.gray("—");
    lines.push(
      `  ${s.ruleId.padEnd(38)} ${stage} ${conf.padEnd(24)} ${savedStr.padEnd(16)} ${s.calls}`,
    );
  }
  return lines.join("\n");
}

/** System status section — outcomes, CCR, budget, index, memory, guard. */
function systemStatus(warden: Warden): string {
  const lines = [``, chalk.bold.gray(`  system status:`)];

  // Outcomes — proves pruning doesn't cause regressions
  const outcomes = warden.store.taskOutcomeStats();
  if (outcomes.total > 0) {
    const prunedPct = outcomes.prunedSuccessRate
      ? Math.round(outcomes.prunedSuccessRate * 100)
      : 0;
    const rawPct = outcomes.rawSuccessRate
      ? Math.round(outcomes.rawSuccessRate * 100)
      : 0;
    const signal = prunedPct >= rawPct ? chalk.green("no regression") : chalk.red("REGRESSION");
    lines.push(
      `  ${chalk.gray("outcomes:")} ${outcomes.total} tasks  pruned: ${chalk.green(`${prunedPct}%`)}  raw: ${chalk.gray(`${rawPct}%`)}  ${signal}`,
    );
  } else {
    lines.push(
      `  ${chalk.gray("outcomes:")} ${chalk.gray("(no tasks tracked yet)")}`,
    );
  }

  // CCR cache — reversible pruning originals
  const ccr = ccrSummary(warden.store);
  if (ccr.count > 0) {
    lines.push(
      `  ${chalk.gray("ccr cache:")} ${ccr.count} originals  ${chalk.green(`${ccr.tokensSaved.toLocaleString()} tokens retrievable`)}`,
    );
  } else {
    lines.push(`  ${chalk.gray("ccr cache:")} ${chalk.gray("(empty)")}`);
  }

  // Budget caps
  const budgets = budgetReport();
  if (budgets.length > 0) {
    for (const b of budgets) {
      const pct = ((b.spent / b.cap) * 100).toFixed(0);
      const status = b.exceeded
        ? chalk.red("EXCEEDED")
        : Number(pct) > 80
          ? chalk.yellow(`${pct}%`)
          : chalk.green("OK");
      lines.push(
        `  ${chalk.gray("budget:")} ${b.scope.padEnd(25)} ${String(b.spent).padStart(8)} / ${String(b.cap).padStart(8)} ${status}`,
      );
    }
  } else {
    lines.push(`  ${chalk.gray("budget:")} ${chalk.gray("(no caps set)")}`);
  }

  // Code index
  if (warden.repoRoot) {
    try {
      const idx = new CodeIndex(warden.store);
      const stats = idx.indexStats(warden.repoRoot);
      if (stats.files > 0) {
        lines.push(
          `  ${chalk.gray("code index:")} ${stats.files} files  ${stats.symbols} symbols  ${stats.imports} imports  ${stats.calls} calls`,
        );
      } else {
        lines.push(
          `  ${chalk.gray("code index:")} ${chalk.gray("(not indexed — run `warden index`")}`,
        );
      }
    } catch {
      lines.push(`  ${chalk.gray("code index:")} ${chalk.gray("(unavailable)")}`);
    }
  }

  // Memory count
  const memories = warden.memory.list(1000);
  if (memories.length > 0 && memories[0]) {
    const lastMemory = memories[0];
    const age = lastMemory.timestamp.slice(0, 10);
    lines.push(
      `  ${chalk.gray("memory:")} ${memories.length} stored  last: ${chalk.gray(age)} ${lastMemory.title.slice(0, 40)}`,
    );
  } else {
    lines.push(`  ${chalk.gray("memory:")} ${chalk.gray("(no memories saved)")}`);
  }

  // Guard status — always on, always verifying
  lines.push(
    `  ${chalk.gray("trust guard:")} ${chalk.green("active")}  ${chalk.gray("verifies every prune — verbatim or raw ships")}`,
  );

  return lines.join("\n");
}

function recentDecisions(warden: Warden, limit = 5): string {
  const decisions = warden.store.recentDecisions(limit);
  if (decisions.length === 0) return chalk.gray("  (no decisions yet)");
  const lines = [``, chalk.gray(`  recent decisions:`)];
  for (const d of decisions) {
    const kind =
      d.kind === "prune"
        ? chalk.green(d.kind)
        : d.kind === "revert"
          ? chalk.red(d.kind)
          : d.kind === "promote"
            ? chalk.cyan(d.kind)
            : chalk.gray(d.kind);
    lines.push(
      `  ${chalk.gray(d.timestamp.slice(11, 19))} ${kind.padEnd(10)} ${d.rule_id ?? "-"} ${chalk.gray(`saved=${d.tokens_saved}`)}`,
    );
  }
  return lines.join("\n");
}

/** Recent memories — last few saved decisions/findings. */
function recentMemories(warden: Warden, limit = 3): string {
  const memories = warden.memory.list(limit);
  if (memories.length === 0) return "";
  const lines = [``, chalk.gray(`  recent memories:`)];
  for (const m of memories) {
    if (!m) continue;
    const cat =
      m.category === "decision"
        ? chalk.cyan(m.category)
        : m.category === "finding"
          ? chalk.yellow(m.category)
          : m.category === "pattern"
            ? chalk.green(m.category)
            : chalk.gray(m.category);
    lines.push(
      `  ${chalk.gray(m.timestamp.slice(0, 10))} ${cat.padEnd(12)} ${m.title.slice(0, 50)}`,
    );
  }
  return lines.join("\n");
}

export async function renderHud(warden: Warden): Promise<string> {
  const global = await collectGlobalStats();
  return [
    header(warden),
    globalSummary(global),
    rulesTable(warden),
    systemStatus(warden),
    recentDecisions(warden),
    recentMemories(warden),
    "",
  ].join("\n");
}

export async function renderOnce(warden: Warden): Promise<void> {
  process.stdout.write("\u001B[2J\u001B[H"); // clear screen
  process.stdout.write((await renderHud(warden)) + "\n");
}

export async function renderLive(
  warden: Warden,
  intervalMs = 2000,
): Promise<void> {
  // Hide cursor, clear screen.
  process.stdout.write("\u001B[?25l");
  const refresh = async () => {
    process.stdout.write("\u001B[2J\u001B[H");
    process.stdout.write((await renderHud(warden)) + "\n");
    process.stdout.write(
      chalk.gray("  refreshing every 2s — Ctrl+C to exit\n"),
    );
  };
  await refresh();
  const timer = setInterval(() => void refresh(), intervalMs);

  // Clean up on exit.
  const cleanup = () => {
    clearInterval(timer);
    process.stdout.write("\u001B[?25h"); // show cursor
    warden.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return new Promise(() => {}); // run until killed
}

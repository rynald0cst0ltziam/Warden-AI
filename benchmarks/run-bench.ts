/**
 * Warden Benchmark Suite — measured, not estimated.
 *
 * Runs real pruning on real-world fixtures and outputs raw data.
 * One command: npx tsx benchmarks/run-bench.ts
 *
 * Output:
 *   - Console summary table
 *   - benchmarks/results/raw/per-task.csv  (per-task results)
 *   - benchmarks/results/raw/per-task.json (machine-readable)
 *   - benchmarks/results/summary.csv       (aggregate)
 *
 * Methodology:
 *   - Each fixture is a realistic sample of what an agent would see
 *   - Raw tokens estimated via approxTokens() (same heuristic used in production)
 *   - Pruned tokens measured from actual pruning engine output
 *   - Guard verified on every prune (trust guard invariant)
 *   - Pruning overhead measured with performance.now()
 *   - No self-reported numbers — all values are calculated
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Warden } from "../src/warden.js";
import { approxTokens } from "../src/pruner/types.js";
import { compressFile } from "../src/compress/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = __dirname;
const FIXTURES_DIR = join(BENCH_DIR, "fixtures");
const RESULTS_DIR = join(BENCH_DIR, "results", "raw");

interface BenchTask {
  id: string;
  name: string;
  type: string;
  fixtureFile: string;
  taskHint: string;
  category: "grep" | "fileread" | "testlog" | "generic" | "compress" | "shell-output";
}

interface TaskResult {
  id: string;
  name: string;
  category: string;
  toolType: string;
  rawTokens: number;
  prunedTokens: number;
  tokensSaved: number;
  reductionPct: number;
  guardOk: boolean;
  overheadMs: number;
  taskHint: string;
}

// 25 benchmark tasks — varied types, sizes, and categories
const TASKS: BenchTask[] = [
  // Grep output tasks (5)
  {
    id: "grep-001",
    name: "grep: auth middleware (large)",
    type: "grep",
    fixtureFile: "grep-large.txt",
    taskHint: "find authentication middleware functions",
    category: "grep",
  },
  {
    id: "grep-002",
    name: "grep: auth middleware (medium)",
    type: "grep",
    fixtureFile: "grep-large.txt",
    taskHint: "find JWT token verification logic",
    category: "grep",
  },
  {
    id: "grep-003",
    name: "grep: auth middleware (narrow)",
    type: "grep",
    fixtureFile: "grep-large.txt",
    taskHint: "find rate limiting implementation",
    category: "grep",
  },
  {
    id: "grep-004",
    name: "grep: route handlers (broad)",
    type: "grep",
    fixtureFile: "grep-large.txt",
    taskHint: "find all API route handlers",
    category: "grep",
  },
  {
    id: "grep-005",
    name: "grep: model schema (specific)",
    type: "grep",
    fixtureFile: "grep-large.txt",
    taskHint: "find user model schema definition",
    category: "grep",
  },

  // Test output tasks (5)
  {
    id: "test-001",
    name: "test: full suite (187 tests)",
    type: "testlog",
    fixtureFile: "test-output-large.txt",
    taskHint: "check if all tests pass",
    category: "testlog",
  },
  {
    id: "test-002",
    name: "test: auth middleware tests",
    type: "testlog",
    fixtureFile: "test-output-large.txt",
    taskHint: "find failing auth middleware tests",
    category: "testlog",
  },
  {
    id: "test-003",
    name: "test: API route tests",
    type: "testlog",
    fixtureFile: "test-output-large.txt",
    taskHint: "check API route test results",
    category: "testlog",
  },
  {
    id: "test-004",
    name: "test: model tests",
    type: "testlog",
    fixtureFile: "test-output-large.txt",
    taskHint: "verify user model tests pass",
    category: "testlog",
  },
  {
    id: "test-005",
    name: "test: service tests",
    type: "testlog",
    fixtureFile: "test-output-large.txt",
    taskHint: "check email and search service tests",
    category: "testlog",
  },

  // File read tasks (5)
  {
    id: "file-001",
    name: "file: database service (835 lines)",
    type: "fileread",
    fixtureFile: "source-large.ts",
    taskHint: "understand the DatabaseService class",
    category: "fileread",
  },
  {
    id: "file-002",
    name: "file: database service (find methods)",
    type: "fileread",
    fixtureFile: "source-large.ts",
    taskHint: "find all user-related methods",
    category: "fileread",
  },
  {
    id: "file-003",
    name: "file: database service (session ops)",
    type: "fileread",
    fixtureFile: "source-large.ts",
    taskHint: "find session management methods",
    category: "fileread",
  },
  {
    id: "file-004",
    name: "file: database service (audit log)",
    type: "fileread",
    fixtureFile: "source-large.ts",
    taskHint: "find audit log implementation",
    category: "fileread",
  },
  {
    id: "file-005",
    name: "file: database service (health check)",
    type: "fileread",
    fixtureFile: "source-large.ts",
    taskHint: "find health check service",
    category: "fileread",
  },

  // Generic output tasks (5)
  {
    id: "gen-001",
    name: "generic: grep output as generic",
    type: "generic",
    fixtureFile: "grep-large.txt",
    taskHint: "review code search results",
    category: "generic",
  },
  {
    id: "gen-002",
    name: "generic: test output as generic",
    type: "generic",
    fixtureFile: "test-output-large.txt",
    taskHint: "review test results",
    category: "generic",
  },
  {
    id: "gen-003",
    name: "generic: source file as generic",
    type: "generic",
    fixtureFile: "source-large.ts",
    taskHint: "review source code",
    category: "generic",
  },
  {
    id: "gen-004",
    name: "generic: grep output (broad task)",
    type: "generic",
    fixtureFile: "grep-large.txt",
    taskHint: "understand the codebase structure",
    category: "generic",
  },
  {
    id: "gen-005",
    name: "generic: test output (broad task)",
    type: "generic",
    fixtureFile: "test-output-large.txt",
    taskHint: "understand test coverage",
    category: "generic",
  },

  // Shell output tasks (5) — tests the shell-output pruning module
  {
    id: "shell-001",
    name: "shell: git log (50 commits)",
    type: "shell-output",
    fixtureFile: "shell-git-log.txt",
    taskHint: "review recent commit history for auth changes",
    category: "shell-output",
  },
  {
    id: "shell-002",
    name: "shell: docker logs (server crash)",
    type: "shell-output",
    fixtureFile: "shell-docker-logs.txt",
    taskHint: "find the cause of the server crash",
    category: "shell-output",
  },
  {
    id: "shell-003",
    name: "shell: npm install (487 packages)",
    type: "shell-output",
    fixtureFile: "shell-npm-install.txt",
    taskHint: "check for vulnerabilities and deprecated packages",
    category: "shell-output",
  },
  {
    id: "shell-004",
    name: "shell: cargo build (150 crates)",
    type: "shell-output",
    fixtureFile: "shell-cargo-build.txt",
    taskHint: "check for compilation warnings and errors",
    category: "shell-output",
  },
  {
    id: "shell-005",
    name: "shell: find (147 files)",
    type: "shell-output",
    fixtureFile: "shell-find.txt",
    taskHint: "find all test files in the project",
    category: "shell-output",
  },

  // File compression tasks (5) — uses compressFile, not pruning engine
  {
    id: "comp-001",
    name: "compress: source file (lite)",
    type: "compress-lite",
    fixtureFile: "source-large.ts",
    taskHint: "compress file",
    category: "compress",
  },
  {
    id: "comp-002",
    name: "compress: source file (full)",
    type: "compress-full",
    fixtureFile: "source-large.ts",
    taskHint: "compress file",
    category: "compress",
  },
  {
    id: "comp-003",
    name: "compress: source file (ultra)",
    type: "compress-ultra",
    fixtureFile: "source-large.ts",
    taskHint: "compress file",
    category: "compress",
  },
  {
    id: "comp-004",
    name: "compress: grep output (ultra)",
    type: "compress-ultra",
    fixtureFile: "grep-large.txt",
    taskHint: "compress file",
    category: "compress",
  },
  {
    id: "comp-005",
    name: "compress: test output (ultra)",
    type: "compress-ultra",
    fixtureFile: "test-output-large.txt",
    taskHint: "compress file",
    category: "compress",
  },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function runPruningTask(
  warden: Warden,
  task: BenchTask,
  rawContent: string,
): Promise<TaskResult> {
  const rawTokens = approxTokens(rawContent);
  const t0 = performance.now();

  const res = await warden.pruneCall({
    toolType: task.type as never,
    rawOutput: rawContent,
    taskHint: task.taskHint,
    toolName: `bench-${task.id}`,
  });

  const overheadMs = Math.round(performance.now() - t0);
  const prunedTokens = res.result.tokensPruned;
  const tokensSaved = rawTokens - prunedTokens;
  const reductionPct = rawTokens > 0 ? Math.round((tokensSaved / rawTokens) * 1000) / 10 : 0;

  return {
    id: task.id,
    name: task.name,
    category: task.category,
    toolType: task.type,
    rawTokens,
    prunedTokens,
    tokensSaved,
    reductionPct,
    guardOk: res.result.guardOk,
    overheadMs,
    taskHint: task.taskHint,
  };
}

function runCompressTask(
  task: BenchTask,
  rawContent: string,
): TaskResult {
  const level = task.type.replace("compress-", "") as "lite" | "full" | "ultra";
  const rawTokens = approxTokens(rawContent);
  const t0 = performance.now();

  const result = compressFile(rawContent, level);
  const overheadMs = Math.round(performance.now() - t0);
  const prunedTokens = result.tokensAfter;
  const tokensSaved = rawTokens - prunedTokens;
  const reductionPct = rawTokens > 0 ? Math.round((tokensSaved / rawTokens) * 1000) / 10 : 0;

  return {
    id: task.id,
    name: task.name,
    category: task.category,
    toolType: task.type,
    rawTokens,
    prunedTokens,
    tokensSaved,
    reductionPct,
    guardOk: result.validationOk,
    overheadMs,
    taskHint: task.taskHint,
  };
}

async function main() {
  console.log("");
  console.log("  Warden Benchmark Suite — 30 tasks, measured not estimated");
  console.log("  ──────────────────────────────────────────────────────────────");
  console.log("");

  // Ensure results directory exists
  mkdirSync(RESULTS_DIR, { recursive: true });

  // Load fixtures
  const fixtureCache = new Map<string, string>();
  function loadFixture(name: string): string {
    if (!fixtureCache.has(name)) {
      const path = join(FIXTURES_DIR, name);
      if (!existsSync(path)) {
        throw new Error(`Fixture not found: ${path}`);
      }
      fixtureCache.set(name, readFileSync(path, "utf8"));
    }
    return fixtureCache.get(name)!;
  }

  // Initialize Warden
  let warden: Warden;
  try {
    warden = await Warden.create();
  } catch (e) {
    console.error(`  Failed to initialize Warden: ${(e as Error).message}`);
    process.exit(1);
  }

  // Run all tasks
  const results: TaskResult[] = [];
  let allGuardOk = true;

  // Header
  console.log(
    "  " +
      "ID".padEnd(10) +
      "Task".padEnd(40) +
      "Raw".padStart(8) +
      "Pruned".padStart(8) +
      "Saved".padStart(8) +
      "Reduction".padStart(10) +
      "Guard".padStart(7) +
      "Overhead".padStart(10),
  );
  console.log("  " + "─".repeat(93));

  for (const task of TASKS) {
    try {
      const rawContent = loadFixture(task.fixtureFile);
      let result: TaskResult;

      if (task.type.startsWith("compress-")) {
        result = runCompressTask(task, rawContent);
      } else {
        result = await runPruningTask(warden, task, rawContent);
      }

      if (!result.guardOk) allGuardOk = false;
      results.push(result);

      const guard = result.guardOk ? "✓" : "✗";
      console.log(
        "  " +
          result.id.padEnd(10) +
          result.name.padEnd(40) +
          fmt(result.rawTokens).padStart(8) +
          fmt(result.prunedTokens).padStart(8) +
          fmt(result.tokensSaved).padStart(8) +
          (result.reductionPct + "%").padStart(10) +
          guard.padStart(7) +
          (result.overheadMs + "ms").padStart(10),
      );
    } catch (e) {
      console.log(
        "  " + task.id.padEnd(10) + task.name.padEnd(40) + " ERROR: " + (e as Error).message,
      );
    }
  }

  // Aggregate
  console.log("  " + "─".repeat(93));

  const byCategory = new Map<string, TaskResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  let totalRaw = 0;
  let totalPruned = 0;
  let totalSaved = 0;
  let totalOverhead = 0;
  for (const r of results) {
    totalRaw += r.rawTokens;
    totalPruned += r.prunedTokens;
    totalSaved += r.tokensSaved;
    totalOverhead += r.overheadMs;
  }
  const overallReduction = totalRaw > 0 ? Math.round((totalSaved / totalRaw) * 1000) / 10 : 0;

  console.log(
    "  " +
      "OVERALL".padEnd(50) +
      fmt(totalRaw).padStart(8) +
      fmt(totalPruned).padStart(8) +
      fmt(totalSaved).padStart(8) +
      (overallReduction + "%").padStart(10) +
      (allGuardOk ? "✓" : "✗").padStart(7) +
      (totalOverhead + "ms").padStart(10),
  );
  console.log("");

  // Per-category breakdown
  console.log("  ── Per-Category Breakdown ──");
  console.log("");
  console.log(
    "  " +
      "Category".padEnd(15) +
      "Tasks".padStart(6) +
      "Raw".padStart(10) +
      "Pruned".padStart(10) +
      "Saved".padStart(10) +
      "Reduction".padStart(10) +
      "Avg Overhead".padStart(14),
  );
  console.log("  " + "─".repeat(75));

  const categoryRows: Array<{
    category: string;
    tasks: number;
    raw: number;
    pruned: number;
    saved: number;
    reductionPct: number;
    avgOverheadMs: number;
  }> = [];

  for (const [category, catResults] of byCategory) {
    const catRaw = catResults.reduce((s, r) => s + r.rawTokens, 0);
    const catPruned = catResults.reduce((s, r) => s + r.prunedTokens, 0);
    const catSaved = catResults.reduce((s, r) => s + r.tokensSaved, 0);
    const catOverhead = catResults.reduce((s, r) => s + r.overheadMs, 0);
    const catReduction = catRaw > 0 ? Math.round((catSaved / catRaw) * 1000) / 10 : 0;
    const avgOverhead = Math.round(catOverhead / catResults.length);

    categoryRows.push({
      category,
      tasks: catResults.length,
      raw: catRaw,
      pruned: catPruned,
      saved: catSaved,
      reductionPct: catReduction,
      avgOverheadMs: avgOverhead,
    });

    console.log(
      "  " +
        category.padEnd(15) +
        String(catResults.length).padStart(6) +
        fmt(catRaw).padStart(10) +
        fmt(catPruned).padStart(10) +
        fmt(catSaved).padStart(10) +
        (catReduction + "%").padStart(10) +
        (avgOverhead + "ms").padStart(14),
    );
  }
  console.log("");

  // Write CSV: per-task
  const csvHeader =
    "id,name,category,tool_type,raw_tokens,pruned_tokens,tokens_saved,reduction_pct,guard_ok,overhead_ms,task_hint\n";
  const csvRows = results
    .map(
      (r) =>
        `${r.id},${JSON.stringify(r.name)},${r.category},${r.toolType},${r.rawTokens},${r.prunedTokens},${r.tokensSaved},${r.reductionPct},${r.guardOk},${r.overheadMs},${JSON.stringify(r.taskHint)}`,
    )
    .join("\n");
  const csvPath = join(RESULTS_DIR, "per-task.csv");
  writeFileSync(csvPath, csvHeader + csvRows + "\n");
  console.log(`  Per-task CSV: ${csvPath}`);

  // Write JSON: per-task
  const jsonPath = join(RESULTS_DIR, "per-task.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        wardenVersion: "1.0.0",
        taskCount: results.length,
        guardAllPassed: allGuardOk,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`  Per-task JSON: ${jsonPath}`);

  // Write summary CSV
  const summaryCsvPath = join(BENCH_DIR, "results", "summary.csv");
  const summaryCsvHeader =
    "category,tasks,raw_tokens,pruned_tokens,tokens_saved,reduction_pct,avg_overhead_ms\n";
  const summaryCsvRows = categoryRows
    .map(
      (r) =>
        `${r.category},${r.tasks},${r.raw},${r.pruned},${r.saved},${r.reductionPct},${r.avgOverheadMs}`,
    )
    .join("\n");
  writeFileSync(summaryCsvPath, summaryCsvHeader + summaryCsvRows + "\n");
  console.log(`  Summary CSV:   ${summaryCsvPath}`);

  // Write summary JSON
  const summaryJsonPath = join(BENCH_DIR, "results", "summary.json");
  writeFileSync(
    summaryJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        wardenVersion: "1.0.0",
        totalTasks: results.length,
        guardAllPassed: allGuardOk,
        overall: {
          rawTokens: totalRaw,
          prunedTokens: totalPruned,
          tokensSaved: totalSaved,
          reductionPct: overallReduction,
          totalOverheadMs: totalOverhead,
        },
        byCategory: categoryRows,
      },
      null,
      2,
    ),
  );
  console.log(`  Summary JSON:  ${summaryJsonPath}`);

  console.log("");
  console.log("  ── Summary ──");
  console.log("");
  console.log(`  Tasks run:           ${results.length}`);
  console.log(`  Total raw tokens:    ${fmt(totalRaw)}`);
  console.log(`  Total pruned tokens: ${fmt(totalPruned)}`);
  console.log(`  Total saved:         ${fmt(totalSaved)}`);
  console.log(`  Overall reduction:   ${overallReduction}%`);
  console.log(`  Guard pass rate:     ${allGuardOk ? "100%" : "FAILURES DETECTED"}`);
  console.log(`  Total overhead:      ${totalOverhead}ms`);
  console.log(`  Avg overhead/task:   ${Math.round(totalOverhead / results.length)}ms`);
  console.log("");

  warden.close?.();
}

main().catch((e) => {
  console.error("Benchmark failed:", e);
  process.exit(1);
});

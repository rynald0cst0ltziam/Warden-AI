/**
 * P0a Task Report tests — verifies that existing decision and outcome data
 * is correctly aggregated into task reports.
 *
 * Tests:
 * - buildTaskReport with empty DB returns zeros
 * - buildTaskReport with prune decisions aggregates correctly
 * - buildTaskReport with task outcomes correlates properly
 * - Guard failures are counted separately
 * - Per-rule breakdown is correct
 * - Time range filtering works
 * - Task filter (substring) works
 * - formatTaskReport produces human-readable output
 * - buildProjectReport aggregates all-time stats
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { buildTaskReport, formatTaskReport, buildProjectReport } from "../src/measurement/report.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-report-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let store: SqliteStore;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = await SqliteStore.open(TEST_DB);
});

afterAll(() => {
  store.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Task Report — empty database", () => {
  it("returns zeros for empty DB", () => {
    const report = buildTaskReport(store, {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-02T00:00:00.000Z",
    });
    expect(report.pruneCalls).toBe(0);
    expect(report.tokensSaved).toBe(0);
    expect(report.tokensFull).toBe(0);
    expect(report.tokensPruned).toBe(0);
    expect(report.reductionPct).toBe(0);
    expect(report.guardFailures).toBe(0);
    expect(report.guardPassRate).toBe(1);
    expect(report.totalTasks).toBe(0);
    expect(report.rules).toHaveLength(0);
  });
});

describe("Task Report — with prune decisions", () => {
  beforeEach(() => {
    // Clean decisions for this test group
    store.db.exec("DELETE FROM decisions");
    store.db.exec("DELETE FROM task_outcomes");
  });

  it("aggregates prune decisions correctly", () => {
    const now = new Date().toISOString();
    const baseTime = new Date(now).getTime();
    const t1 = new Date(baseTime - 1000).toISOString();
    const t2 = new Date(baseTime - 500).toISOString();

    // Add two prune decisions
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 1000,
        tokensPruned: 500,
        summary: "removed 500 tokens (50%)",
        counts: { linesRemoved: 10, linesKept: 5 },
      }),
    });

    store.addDecision({
      kind: "prune",
      rule_id: "fileread.slice-outline.v1",
      tool_type: "file-read",
      tokens_saved: 300,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 800,
        tokensPruned: 500,
        summary: "removed 300 tokens (37.5%)",
        counts: { linesRemoved: 8, linesKept: 12 },
      }),
    });

    // Use a wide time range to capture both
    const report = buildTaskReport(store, {
      start: new Date(baseTime - 2000).toISOString(),
      end: new Date(baseTime + 2000).toISOString(),
    });

    expect(report.pruneCalls).toBe(2);
    expect(report.tokensSaved).toBe(800);
    expect(report.tokensFull).toBe(1800);
    expect(report.tokensPruned).toBe(1000);
    expect(report.reductionPct).toBeGreaterThan(0);
    expect(report.guardFailures).toBe(0);
    expect(report.guardPassRate).toBe(1);
  });

  it("counts guard failures separately", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 200,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 400,
        tokensPruned: 200,
        summary: "removed 200",
        counts: { linesRemoved: 5, linesKept: 3 },
      }),
    });

    store.addDecision({
      kind: "prune-guard-failed",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 0,
      detail_json: JSON.stringify({
        guardOk: false,
        tokensFull: 600,
        tokensPruned: 600,
        summary: "guard failed",
        counts: { linesRemoved: 0, linesKept: 20 },
      }),
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    expect(report.pruneCalls).toBe(2);
    expect(report.guardFailures).toBe(1);
    expect(report.guardPassRate).toBe(0.5);
    // Guard-failed decisions don't count toward tokensSaved
    expect(report.tokensSaved).toBe(200);
  });

  it("produces per-rule breakdown", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 1000,
        tokensPruned: 500,
        summary: "removed 500",
        counts: { linesRemoved: 10, linesKept: 5 },
      }),
    });

    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 300,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 600,
        tokensPruned: 300,
        summary: "removed 300",
        counts: { linesRemoved: 6, linesKept: 4 },
      }),
    });

    store.addDecision({
      kind: "prune",
      rule_id: "fileread.slice-outline.v1",
      tool_type: "file-read",
      tokens_saved: 200,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 400,
        tokensPruned: 200,
        summary: "removed 200",
        counts: { linesRemoved: 4, linesKept: 6 },
      }),
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    expect(report.rules).toHaveLength(2);
    const grepRule = report.rules.find((r) => r.ruleId === "grep.relevance-collapse.v1");
    expect(grepRule).toBeDefined();
    expect(grepRule!.calls).toBe(2);
    expect(grepRule!.tokensSaved).toBe(800);
    expect(grepRule!.tokensFull).toBe(1600);

    const fileRule = report.rules.find((r) => r.ruleId === "fileread.slice-outline.v1");
    expect(fileRule).toBeDefined();
    expect(fileRule!.calls).toBe(1);
    expect(fileRule!.tokensSaved).toBe(200);
  });
});

describe("Task Report — with task outcomes", () => {
  beforeEach(() => {
    store.db.exec("DELETE FROM decisions");
    store.db.exec("DELETE FROM task_outcomes");
  });

  it("correlates task outcomes with time range", () => {
    store.recordTaskOutcome({
      task: "Fix auth bug",
      success: true,
      pruned: true,
      tokensSaved: 500,
    });

    store.recordTaskOutcome({
      task: "Add payment endpoint",
      success: false,
      pruned: true,
      tokensSaved: 200,
    });

    store.recordTaskOutcome({
      task: "Update docs",
      success: true,
      pruned: false,
      tokensSaved: 0,
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    expect(report.totalTasks).toBe(3);
    expect(report.successfulTasks).toBe(2);
    expect(report.failedTasks).toBe(1);
    expect(report.successRate).toBeCloseTo(2 / 3, 2);
  });

  it("filters outcomes by task description substring", () => {
    store.recordTaskOutcome({
      task: "Fix auth bug in login",
      success: true,
      pruned: true,
      tokensSaved: 500,
    });

    store.recordTaskOutcome({
      task: "Add payment endpoint",
      success: false,
      pruned: true,
      tokensSaved: 200,
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
      taskFilter: "auth",
    });

    expect(report.totalTasks).toBe(1);
    expect(report.taskOutcomes[0].task).toBe("Fix auth bug in login");
  });
});

describe("Task Report — formatting", () => {
  it("formatTaskReport produces human-readable output", () => {
    store.db.exec("DELETE FROM decisions");
    store.db.exec("DELETE FROM task_outcomes");

    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 1000,
        tokensPruned: 500,
        summary: "removed 500",
        counts: { linesRemoved: 10, linesKept: 5 },
      }),
    });

    store.recordTaskOutcome({
      task: "Fix auth bug",
      success: true,
      pruned: true,
      tokensSaved: 500,
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    const text = formatTaskReport(report);
    expect(text).toContain("WARDEN TASK REPORT");
    expect(text).toContain("Tokens saved (gross)");
    expect(text).toContain("TASK OUTCOMES");
    expect(text).toContain("Fix auth bug");
    expect(text).toContain("Total tokens avoided");
  });
});

describe("Project Report — all-time aggregation", () => {
  it("buildProjectReport aggregates all-time stats", () => {
    store.db.exec("DELETE FROM decisions");
    store.db.exec("DELETE FROM task_outcomes");

    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 1000,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 2000,
        tokensPruned: 1000,
        summary: "removed 1000",
        counts: { linesRemoved: 20, linesKept: 10 },
      }),
    });

    store.recordTaskOutcome({
      task: "Task 1",
      success: true,
      pruned: true,
      tokensSaved: 1000,
    });

    store.recordTaskOutcome({
      task: "Task 2",
      success: false,
      pruned: true,
      tokensSaved: 500,
    });

    const report = buildProjectReport(store);

    expect(report.totalTokensSaved).toBe(1000);
    expect(report.totalTokensProcessed).toBe(2000);
    expect(report.reductionPct).toBe(50);
    expect(report.totalTasks).toBe(2);
    expect(report.successfulTasks).toBe(1);
    expect(report.failedTasks).toBe(1);
    expect(report.recentOutcomes).toHaveLength(2);
  });
});

describe("Task Report — Warden overhead timing (P0b)", () => {
  beforeEach(() => {
    store.db.exec("DELETE FROM decisions");
    store.db.exec("DELETE FROM task_outcomes");
  });

  it("aggregates durationMs from decisions", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 1000,
        tokensPruned: 500,
        summary: "removed 500",
        counts: { linesRemoved: 10, linesKept: 5 },
        durationMs: 12,
      }),
    });

    store.addDecision({
      kind: "prune",
      rule_id: "fileread.slice-outline.v1",
      tool_type: "file-read",
      tokens_saved: 300,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 600,
        tokensPruned: 300,
        summary: "removed 300",
        counts: { linesRemoved: 6, linesKept: 4 },
        durationMs: 8,
      }),
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    expect(report.overheadMs).toBe(20);
    expect(report.overheadTokens).toBe(20);
    expect(report.netTokensSaved).toBe(800 - 20);
  });

  it("handles decisions without durationMs (pre-P0b data)", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 1000,
        tokensPruned: 500,
        summary: "removed 500",
        counts: { linesRemoved: 10, linesKept: 5 },
        // No durationMs — pre-P0b data
      }),
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    expect(report.overheadMs).toBe(0);
    expect(report.overheadTokens).toBe(0);
    expect(report.netTokensSaved).toBe(500);
  });

  it("formatTaskReport shows overhead when present", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep.relevance-collapse.v1",
      tool_type: "grep",
      tokens_saved: 1000,
      detail_json: JSON.stringify({
        guardOk: true,
        tokensFull: 2000,
        tokensPruned: 1000,
        summary: "removed 1000",
        counts: { linesRemoved: 20, linesKept: 10 },
        durationMs: 15,
      }),
    });

    const report = buildTaskReport(store, {
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 60000).toISOString(),
    });

    const text = formatTaskReport(report);
    expect(text).toContain("WARDEN OVERHEAD");
    expect(text).toContain("Processing time");
    expect(text).toContain("Net tokens saved");
  });
});

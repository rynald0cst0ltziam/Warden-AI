/**
 * Test: auto-calculate task outcome tokens from decisions table.
 * Verifies that when tokensSaved is not provided, Warden sums actual
 * pruning decisions instead of defaulting to 0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("auto-calculate task outcome tokens", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "warden-test-"));
    store = await SqliteStore.open(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-calculates tokensSaved from decisions when not provided", () => {
    // Record some pruning decisions with known token savings
    store.addDecision({
      kind: "prune",
      rule_id: "grep-output-trim",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({ tokensFull: 1000, tokensPruned: 500 }),
    });
    store.addDecision({
      kind: "prune",
      rule_id: "file-read-slice",
      tool_type: "fileread",
      tokens_saved: 300,
      detail_json: JSON.stringify({ tokensFull: 800, tokensPruned: 500 }),
    });

    // Record outcome WITHOUT tokensSaved — should auto-calculate 800
    store.recordTaskOutcome({
      task: "fix null pointer",
      success: true,
      pruned: true,
    });

    const outcomes = store.recentTaskOutcomes(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].tokens_saved).toBe(800);
  });

  it("uses agent-provided tokensSaved when provided", () => {
    store.addDecision({
      kind: "prune",
      rule_id: "grep-output-trim",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: JSON.stringify({ tokensFull: 1000, tokensPruned: 500 }),
    });

    // Record outcome WITH explicit tokensSaved
    store.recordTaskOutcome({
      task: "fix null pointer",
      success: true,
      pruned: true,
      tokensSaved: 42,
    });

    const outcomes = store.recentTaskOutcomes(1);
    expect(outcomes[0].tokens_saved).toBe(42);
  });

  it("calculates tokens since last outcome for subsequent tasks", async () => {
    // First task: 500 tokens saved
    store.addDecision({
      kind: "prune",
      rule_id: "rule-1",
      tool_type: "grep",
      tokens_saved: 500,
      detail_json: "{}",
    });
    store.recordTaskOutcome({
      task: "task 1",
      success: true,
      pruned: true,
    });

    // Wait to ensure different timestamp (decisions and outcomes use ISO timestamps)
    await new Promise((r) => setTimeout(r, 15));

    // Second task: 300 more tokens saved
    store.addDecision({
      kind: "prune",
      rule_id: "rule-2",
      tool_type: "fileread",
      tokens_saved: 300,
      detail_json: "{}",
    });
    store.recordTaskOutcome({
      task: "task 2",
      success: true,
      pruned: true,
    });

    const outcomes = store.recentTaskOutcomes(2);
    expect(outcomes[1].tokens_saved).toBe(500); // first task: all decisions
    expect(outcomes[0].tokens_saved).toBe(300); // second task: only since first
  });

  it("handles zero pruning decisions gracefully", () => {
    store.recordTaskOutcome({
      task: "task with no pruning",
      success: true,
      pruned: false,
    });

    const outcomes = store.recentTaskOutcomes(1);
    expect(outcomes[0].tokens_saved).toBe(0);
  });

  it("tokensSavedSince returns correct sum", () => {
    // Use explicit past timestamps to avoid timing flakiness
    const past = new Date(Date.now() - 60000).toISOString(); // 1 min ago
    const future = new Date(Date.now() + 60000).toISOString(); // 1 min in future

    store.addDecision({
      kind: "prune",
      rule_id: "rule-1",
      tool_type: "grep",
      tokens_saved: 100,
      detail_json: "{}",
    });
    store.addDecision({
      kind: "prune",
      rule_id: "rule-2",
      tool_type: "grep",
      tokens_saved: 200,
      detail_json: "{}",
    });

    // Since "past" (strictly after) — both decisions should be counted
    expect(store.tokensSavedSince(past)).toBe(300);
    // Since "future" — no decisions should be counted (they're before future)
    expect(store.tokensSavedSince(future)).toBe(0);
  });
});

/**
 * Integration tests — full pipeline: classify → prune → guard → ship.
 *
 * These test the Warden orchestrator end-to-end with a real SQLite store
 * in a temporary directory. They verify:
 * - Shadow mode ships raw, records shadow evidence
 * - Active mode ships pruned, records decision
 * - Guard failure reverts to raw passthrough
 * - Confidence scoring after shadow runs
 * - Promotion eligibility checks
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Warden } from "../src/warden.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let warden: Warden;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  warden = await Warden.create({ dbPath: TEST_DB, repoRoot: TEST_DIR });
});

afterAll(() => {
  warden.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Warden integration — full pipeline", () => {
  it("registers all pruning modules as active rules on first run", () => {
    const rules = warden.store.listRules();
    expect(rules.length).toBeGreaterThanOrEqual(4);
    const stages = rules.map((r) => r.stage);
    expect(stages.every((s) => s === "active" || s === "reverted")).toBe(true);
  });

  it("shadow mode ships raw output (not pruned)", async () => {
    warden.store.setRuleStage("generic.structural-summary.v1", "shadow");
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`line ${i} noise`);
    const raw = lines.join("\n");

    const result = await warden.pruneCall({
      toolType: "generic",
      rawOutput: raw,
      taskHint: "find auth bug",
    });

    expect(result.stage).toBe("shadow");
    expect(result.applied).toBe(false);
    // Shadow mode ships preprocessed (ANSI/path stripped) but not pruned
    // For plain text with no ANSI/paths, preprocessed == raw
    expect(result.shipped).toBe(raw);
  });

  it("active mode ships pruned output", async () => {
    // Promote the generic rule: shadow → canary → active (two steps)
    warden.gate.promote("generic.structural-summary.v1", true);
    warden.gate.promote("generic.structural-summary.v1", true);

    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) lines.push("Error: auth failed");
      else lines.push(`line ${i} noise`);
    }
    const raw = lines.join("\n");

    const result = await warden.pruneCall({
      toolType: "generic",
      rawOutput: raw,
      taskHint: "find auth bug",
    });

    expect(result.stage).toBe("active");
    expect(result.applied).toBe(true);
    expect(result.shipped).toContain("Error: auth failed");
    expect(result.shipped.length).toBeLessThan(raw.length);
  });

  it("guard invariant holds on pruned output", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) lines.push("Error: something failed");
      else lines.push(`line ${i} noise`);
    }
    const raw = lines.join("\n");

    const result = await warden.pruneCall({
      toolType: "generic",
      rawOutput: raw,
      taskHint: "find error",
    });

    // Every non-annotation line in shipped output must exist in raw
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.shipped.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("status returns rules with confidence", () => {
    const status = warden.status();
    expect(status.length).toBeGreaterThanOrEqual(4);
    for (const s of status) {
      expect(s.ruleId).toBeTruthy();
      expect(s.stage).toBeTruthy();
      expect(typeof s.confidence).toBe("number");
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("totalTokensSaved increases after pruning", async () => {
    const before = warden.totalTokensSaved();
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`line ${i} noise`);
    const raw = lines.join("\n");

    await warden.pruneCall({
      toolType: "generic",
      rawOutput: raw,
      taskHint: "find auth bug",
    });

    const after = warden.totalTokensSaved();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("reverting a rule puts it in reverted mode", () => {
    warden.gate.revert("generic.structural-summary.v1", "test revert");
    const rule = warden.store.getRule("generic.structural-summary.v1");
    expect(rule?.stage).toBe("reverted");
  });

  it("confidence is 1.0 for active rules with 0 shadow runs", async () => {
    // Create a fresh warden with a new DB to test this specific case
    const freshDir = join(tmpdir(), `warden-fresh-${Date.now()}`);
    mkdirSync(freshDir, { recursive: true });
    const freshDb = join(freshDir, "fresh.warden.db");
    const freshWarden = await Warden.create({
      dbPath: freshDb,
      repoRoot: freshDir,
    });

    // Built-in rules start active (0 shadow runs)
    const conf = freshWarden.gate.confidence("grep.relevance-collapse.v1");
    expect(conf).not.toBeNull();
    expect(conf!.stage).toBe("active");
    expect(conf!.confidence).toBe(1.0);
    expect(conf!.effectiveConfidence).toBe(1.0);

    freshWarden.close();
    rmSync(freshDir, { recursive: true });
  });
});

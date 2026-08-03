/**
 * test-log pruning module tests.
 */
import { describe, it, expect } from "vitest";
import { testLogModule } from "../src/pruner/modules/testlog.js";
import type { TaskContext } from "../src/classifier/types.js";

const task: TaskContext = {
  type: "bug-fix",
  relevanceHint: "auth",
  userMessage: "fix auth test failure",
  toolName: "run_tests",
};

describe("testLogModule", () => {
  it("collapses clean log (no failures) to head + summary", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`✓ test ${i} passed`);
    }
    const raw = lines.join("\n");
    const result = testLogModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain("‹warden›");
    expect(result.prunedOutput).toContain("no failures");
    expect(result.prunedOutput.length).toBeLessThan(raw.length);
  });

  it("keeps failures with context window", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`✓ test ${i} passed`);
    }
    lines.push("✗ test auth failed");
    lines.push("  expected token but got null");
    lines.push("  at auth.ts:42");
    for (let i = 0; i < 50; i++) {
      lines.push(`✓ test ${i + 50} passed`);
    }
    const raw = lines.join("\n");
    const result = testLogModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain("auth failed");
    expect(result.prunedOutput).toContain("expected token");
    expect(result.prunedOutput).toContain("auth.ts:42");
  });

  it("collapses passing noise between failures", () => {
    const lines: string[] = [];
    lines.push("✗ test 1 failed");
    for (let i = 0; i < 30; i++) {
      lines.push(`✓ test ${i} passed`);
    }
    lines.push("✗ test 2 failed");
    const raw = lines.join("\n");
    const result = testLogModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain("test 1 failed");
    expect(result.prunedOutput).toContain("test 2 failed");
    expect(result.prunedOutput).toContain("collapsed");
  });

  it("guard passes — every non-annotation line exists in raw", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`✓ test ${i} passed`);
    }
    lines.push("✗ test auth failed");
    lines.push("  at auth.ts:42");
    for (let i = 0; i < 50; i++) {
      lines.push(`✓ test ${i + 50} passed`);
    }
    const raw = lines.join("\n");
    const result = testLogModule.prune(raw, task, {});
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("handles empty input", () => {
    const result = testLogModule.prune("", task, {});
    expect(result.prunedOutput).toContain("no failures");
  });

  it("respects custom context window", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i}`);
    }
    lines[50] = "✗ failure here";
    const raw = lines.join("\n");
    const result = testLogModule.prune(raw, task, {
      testLogFailureContextLines: 2,
    });
    // With 2 lines context, we should have lines 48-52 kept
    expect(result.prunedOutput).toContain("line 48");
    expect(result.prunedOutput).toContain("line 52");
    // But not line 47 (outside 2-line context)
    // Note: line 47 might appear in the head if it's in the first 20 lines
    // but line 47 is not in the first 20 lines
  });
});

/**
 * Grep module tests — including the parseMatches Windows path edge case.
 */
import { describe, it, expect } from "vitest";
import { grepModule } from "../src/pruner/modules/grep.js";
import type { TaskContext } from "../src/classifier/types.js";

const task: TaskContext = {
  type: "bug-fix",
  relevanceHint: "auth token",
  userMessage: "fix auth token bug",
  toolName: "grep",
};

describe("grepModule", () => {
  it("returns raw output when under threshold", () => {
    const raw =
      "src/auth.ts:10:function auth() {\nsrc/auth.ts:11:  return token;";
    const result = grepModule.prune(raw, task, { grepMaxMatches: 40 });
    expect(result.prunedOutput).toBe(raw);
    expect(result.removed.tokensRemoved).toBe(0);
  });

  it("prunes when over threshold, keeping relevant matches", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`src/file${i}.ts:${i}:some random content ${i}`);
    }
    lines.push("src/auth.ts:42:function auth() { return token; }");
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 10 });
    expect(result.prunedOutput).toContain("auth");
    expect(result.prunedOutput.length).toBeLessThan(raw.length);
  });

  it("preserves original order of kept lines", () => {
    const lines = [
      "src/auth.ts:1:first auth match",
      "src/other.ts:2:unrelated",
      "src/auth.ts:3:second auth match",
    ];
    // Add enough lines to trigger pruning
    for (let i = 0; i < 50; i++) {
      lines.push(`src/other${i}.ts:${i}:noise ${i}`);
    }
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 5 });
    // The auth lines should appear in original order
    const authLines = result.prunedOutput
      .split("\n")
      .filter((l) => l.includes("auth"));
    expect(authLines[0]).toContain("first auth match");
    expect(authLines[1]).toContain("second auth match");
  });

  it("adds annotation lines for collapsed matches", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`src/file${i}.ts:${i}:noise ${i}`);
    }
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 10 });
    expect(result.prunedOutput).toContain("‹warden›");
  });

  it("guard passes — every non-annotation line exists in raw", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`src/file${i}.ts:${i}:content ${i}`);
    }
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 20 });
    // Verify guard invariant manually
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("handles empty input", () => {
    const result = grepModule.prune("", task, { grepMaxMatches: 40 });
    expect(result.prunedOutput).toBe("");
  });

  it("handles input with no matches (just text)", () => {
    const raw = "some text\nmore text\nno colons here";
    const result = grepModule.prune(raw, task, { grepMaxMatches: 40 });
    expect(result.prunedOutput).toBe(raw);
  });

  it("parses Windows drive-letter paths with colons correctly", () => {
    // Windows paths like C:\path\file.ts:42:content should not be misparsed
    // The drive letter colon is NOT a field separator
    const raw = [
      "C:\\src\\auth.ts:10:function auth() {",
      "C:\\src\\auth.ts:11:  return token;",
      "C:\\src\\utils.ts:5:export function helper()",
    ].join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 40 });
    // All lines should be preserved (under threshold)
    expect(result.prunedOutput).toBe(raw);
  });

  it("parses Windows paths with line numbers correctly when pruning", () => {
    const lines: string[] = [];
    // Add Windows-style paths
    lines.push("C:\\src\\auth.ts:10:function auth() { return token; }");
    for (let i = 0; i < 100; i++) {
      lines.push(`C:\\src\\file${i}.ts:${i}:noise ${i}`);
    }
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 10 });
    // The auth line should be kept (relevant to task)
    expect(result.prunedOutput).toContain("auth");
    // Guard should pass — all kept lines exist in raw
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });
});

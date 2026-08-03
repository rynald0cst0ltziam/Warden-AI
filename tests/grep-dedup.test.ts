/**
 * Grep module deduplication tests.
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

describe("grepModule — deduplication", () => {
  it("removes exact duplicate lines", () => {
    const raw = [
      "src/auth.ts:42:function auth() {",
      "src/auth.ts:42:function auth() {",
      "src/auth.ts:42:function auth() {",
      "src/utils.ts:10:export const helper = () => {}",
    ].join("\n");
    const result = grepModule.prune(raw, task, {});
    // Should have removed 2 duplicates
    expect(result.removed.counts.duplicates).toBe(2);
    // The remaining output should have the unique lines
    expect(result.prunedOutput).toContain("src/auth.ts:42:function auth() {");
    expect(result.prunedOutput).toContain(
      "src/utils.ts:10:export const helper = () => {}",
    );
  });

  it("guard passes on deduplicated output", () => {
    const raw = [
      "src/auth.ts:42:function auth() {",
      "src/auth.ts:42:function auth() {",
      "src/auth.ts:43:  return token;",
      "src/auth.ts:43:  return token;",
    ].join("\n");
    const result = grepModule.prune(raw, task, {});
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("handles no duplicates gracefully", () => {
    const raw = [
      "src/auth.ts:42:function auth() {",
      "src/utils.ts:10:export const helper = () => {}",
    ].join("\n");
    const result = grepModule.prune(raw, task, {});
    expect(result.removed.counts.duplicates ?? 0).toBe(0);
  });

  it("deduplicates before relevance pruning", () => {
    // Create 100 lines with 50 duplicates
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      const line = `src/file${i}.ts:${i}:content ${i}`;
      lines.push(line);
      lines.push(line); // duplicate
    }
    const raw = lines.join("\n");
    const result = grepModule.prune(raw, task, { grepMaxMatches: 10 });
    // Should have removed 50 duplicates
    expect(result.removed.counts.duplicates).toBe(50);
    // Unique count should be 50
    expect(result.removed.counts.unique).toBe(50);
  });
});

/**
 * file-read pruning module tests.
 */
import { describe, it, expect } from "vitest";
import { fileReadModule } from "../src/pruner/modules/fileread.js";
import type { TaskContext } from "../src/classifier/types.js";

const task: TaskContext = {
  type: "bug-fix",
  relevanceHint: "auth token",
  userMessage: "fix auth token bug",
  toolName: "file_read",
};

function makeLargeFile(lines: number, anchorLine?: string): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (anchorLine && i === Math.floor(lines / 2)) {
      parts.push(anchorLine);
    } else {
      parts.push(`// line ${i} of generic content`);
    }
  }
  return parts.join("\n");
}

describe("fileReadModule", () => {
  it("returns raw when under threshold", () => {
    const raw = "function foo() {\n  return 1;\n}\n";
    const result = fileReadModule.prune(raw, task, {});
    expect(result.prunedOutput).toBe(raw);
    expect(result.removed.tokensRemoved).toBe(0);
  });

  it("prunes large file with no relevance anchor — head + outline", () => {
    const raw = makeLargeFile(500);
    const result = fileReadModule.prune(raw, task, {});
    expect(result.prunedOutput.length).toBeLessThan(raw.length);
    expect(result.prunedOutput).toContain("‹warden›");
    expect(result.removed.counts.lines).toBe(500);
  });

  it("prunes large file with relevance anchor — slice + outline", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (i === 250) {
        lines.push("export function auth(token: string) {");
        lines.push("  return token;");
        lines.push("}");
      } else if (i % 50 === 0 && i !== 250) {
        // Add structural headers so the outline has something to show
        lines.push(`export function func${i}() {`);
        lines.push(`  return ${i};`);
        lines.push("}");
      } else {
        lines.push(`// line ${i}`);
      }
    }
    const raw = lines.join("\n");
    const result = fileReadModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain("auth");
    expect(result.prunedOutput).toContain("token");
    expect(result.prunedOutput.length).toBeLessThan(raw.length);
  });

  it("guard passes — every non-annotation line exists in raw", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (i === 250) {
        lines.push("export function auth(token: string) {");
        lines.push("  return token;");
        lines.push("}");
      } else if (i % 50 === 0 && i !== 250) {
        lines.push(`export function func${i}() {`);
        lines.push(`  return ${i};`);
        lines.push("}");
      } else {
        lines.push(`// line ${i}`);
      }
    }
    const raw = lines.join("\n");
    const result = fileReadModule.prune(raw, task, {});
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("handles empty input", () => {
    const result = fileReadModule.prune("", task, {});
    expect(result.prunedOutput).toBe("");
  });

  it("respects custom threshold", () => {
    const raw = "line1\nline2\nline3\nline4\nline5";
    const result = fileReadModule.prune(raw, task, {
      fileReadLargeThresholdLines: 3,
    });
    // 5 lines > threshold of 3, but no anchor → head + outline
    expect(result.prunedOutput).toContain("‹warden›");
  });
});

/**
 * generic pruning module tests.
 */
import { describe, it, expect } from "vitest";
import { genericModule } from "../src/pruner/modules/generic.js";
import type { TaskContext } from "../src/classifier/types.js";

const task: TaskContext = {
  type: "bug-fix",
  relevanceHint: "auth token",
  userMessage: "fix auth token bug",
  toolName: "run_command",
};

describe("genericModule", () => {
  it("returns raw when under 80 lines (passthrough)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`line ${i}`);
    const raw = lines.join("\n");
    const result = genericModule.prune(raw, task, {});
    expect(result.prunedOutput).toBe(raw);
    expect(result.removed.tokensRemoved).toBe(0);
  });

  it("prunes when over 80 lines — keeps head + error/relevance lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) {
        lines.push("Error: auth token validation failed");
      } else {
        lines.push(`line ${i} low signal noise`);
      }
    }
    const raw = lines.join("\n");
    const result = genericModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain(
      "Error: auth token validation failed",
    );
    expect(result.prunedOutput.length).toBeLessThan(raw.length);
    expect(result.prunedOutput).toContain("‹warden›");
  });

  it("keeps lines matching relevance hint", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) {
        lines.push("checking auth token validity");
      } else {
        lines.push(`line ${i} generic noise`);
      }
    }
    const raw = lines.join("\n");
    const result = genericModule.prune(raw, task, {});
    expect(result.prunedOutput).toContain("checking auth token validity");
  });

  it("guard passes — every non-annotation line exists in raw", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) {
        lines.push("Error: auth failed");
      } else {
        lines.push(`line ${i} noise`);
      }
    }
    const raw = lines.join("\n");
    const result = genericModule.prune(raw, task, {});
    const rawLineSet = new Set(raw.split("\n"));
    for (const line of result.prunedOutput.split("\n")) {
      if (line.startsWith("‹warden›")) continue;
      if (line.trim().length === 0) continue;
      expect(rawLineSet.has(line)).toBe(true);
    }
  });

  it("handles empty input", () => {
    const result = genericModule.prune("", task, {});
    expect(result.prunedOutput).toBe("");
  });

  it("handles input with only errors (all kept)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`Error: something failed at line ${i}`);
    }
    const raw = lines.join("\n");
    const result = genericModule.prune(raw, task, {});
    // All lines are errors, so all should be kept
    expect(result.prunedOutput).not.toContain("collapsed");
  });
});

/**
 * Output token reduction tests.
 *
 * Verifies:
 * - generateOutputRules produces non-empty rules content for each level
 * - Rules include all key sections (hard rules, no echo, auto-clarity, etc.)
 * - Rules include "Never invent abbreviations" and "Never compress these"
 * - Rules include "Auto-clarity" for high-risk situations
 * - estimateOutputSavings returns correct estimates for each level
 * - ESTIMATED_REDUCTION values are valid fractions
 */
import { describe, it, expect } from "vitest";
import {
  generateOutputRules,
  estimateOutputSavings,
  ESTIMATED_REDUCTION,
  DEFAULT_OUTPUT_LEVEL,
  type OutputLevel,
} from "../src/output/index.js";

describe("Output token reduction — generateOutputRules", () => {
  const rules = generateOutputRules();

  it("produces non-empty rules content", () => {
    expect(rules.length).toBeGreaterThan(500);
  });

  it("includes filler words to drop", () => {
    expect(rules).toContain("just");
    expect(rules).toContain("basically");
    expect(rules).toContain("Filler");
  });

  it("includes 'No echo' section", () => {
    expect(rules).toContain("No echo");
    expect(rules).toContain("Do NOT restate code");
  });

  it("includes conclusion-first guidance", () => {
    expect(rules).toContain("Start with the answer");
    expect(rules).toContain("No narration");
  });

  it("includes 'Never invent abbreviations'", () => {
    expect(rules).toContain("Never invent abbreviations");
    expect(rules).toContain("cfg");
    expect(rules).toContain("config");
  });

  it("includes 'Never compress these'", () => {
    expect(rules).toContain("Never compress these");
    expect(rules).toContain("Code blocks");
    expect(rules).toContain("Error messages");
  });

  it("includes 'Auto-clarity' section", () => {
    expect(rules).toContain("Auto-clarity");
    expect(rules).toContain("Security warnings");
  });

  it("includes 'automatic' in the header", () => {
    expect(rules).toContain("automatic");
    expect(rules).not.toContain("L0");
    expect(rules).not.toContain("L1");
    expect(rules).not.toContain("L2");
    expect(rules).not.toContain("L3");
    expect(rules).not.toContain("L4");
    expect(rules).not.toContain("caveman");
    expect(rules).not.toContain("verbosity level");
  });

  it("includes level in the header", () => {
    expect(rules).toContain("full");
  });

  it("includes verbose phrase equivalents", () => {
    expect(rules).toContain("in order to");
    expect(rules).toContain("due to the fact that");
  });

  it("includes no decorative elements rule", () => {
    expect(rules).toContain("No decorative elements");
    expect(rules).toContain("emoji");
  });

  it("includes no tool-call narration rule", () => {
    expect(rules).toContain("No tool-call narration");
  });
});

describe("Output token reduction — levels", () => {
  const levels: OutputLevel[] = ["lite", "full", "ultra"];

  for (const level of levels) {
    it(`level ${level} produces non-empty content`, () => {
      const rules = generateOutputRules(level);
      expect(rules.length).toBeGreaterThan(500);
      expect(rules).toContain(level);
    });

    it(`level ${level} includes hard rules`, () => {
      const rules = generateOutputRules(level);
      expect(rules).toContain("Hard rules");
      expect(rules).toContain("No preamble");
    });

    it(`level ${level} includes never compress section`, () => {
      const rules = generateOutputRules(level);
      expect(rules).toContain("Never compress these");
    });

    it(`level ${level} includes auto-clarity`, () => {
      const rules = generateOutputRules(level);
      expect(rules).toContain("Auto-clarity");
    });
  }

  it("ultra includes article dropping", () => {
    const rules = generateOutputRules("ultra");
    expect(rules).toContain("Drop articles");
  });

  it("lite does not include article dropping", () => {
    const rules = generateOutputRules("lite");
    expect(rules).not.toContain("Drop articles");
  });

  it("full does not include article dropping", () => {
    const rules = generateOutputRules("full");
    expect(rules).not.toContain("Drop articles");
  });
});

describe("Output token reduction — estimateOutputSavings", () => {
  it("estimates savings based on default level (full)", () => {
    const estimate = estimateOutputSavings({ outputTokens: 1000 });
    expect(estimate.estimatedSaved).toBe(
      Math.round(1000 * ESTIMATED_REDUCTION[DEFAULT_OUTPUT_LEVEL]),
    );
    expect(estimate.reductionPct).toBe(
      Math.round(ESTIMATED_REDUCTION[DEFAULT_OUTPUT_LEVEL] * 100),
    );
  });

  it("estimates savings for lite level", () => {
    const estimate = estimateOutputSavings({ outputTokens: 1000, level: "lite" });
    expect(estimate.estimatedSaved).toBe(
      Math.round(1000 * ESTIMATED_REDUCTION.lite),
    );
  });

  it("estimates savings for ultra level", () => {
    const estimate = estimateOutputSavings({ outputTokens: 1000, level: "ultra" });
    expect(estimate.estimatedSaved).toBe(
      Math.round(1000 * ESTIMATED_REDUCTION.ultra),
    );
  });

  it("returns a confidence range with 2 elements", () => {
    const estimate = estimateOutputSavings({ outputTokens: 1000 });
    expect(estimate.confidenceRange).toHaveLength(2);
    expect(estimate.confidenceRange[0]).toBeLessThanOrEqual(
      estimate.estimatedSaved,
    );
    expect(estimate.confidenceRange[1]).toBeGreaterThanOrEqual(
      estimate.estimatedSaved,
    );
  });

  it("scales linearly with output tokens", () => {
    const e1 = estimateOutputSavings({ outputTokens: 1000 });
    const e2 = estimateOutputSavings({ outputTokens: 2000 });
    expect(e2.estimatedSaved).toBe(e1.estimatedSaved * 2);
  });

  it("handles zero output tokens", () => {
    const estimate = estimateOutputSavings({ outputTokens: 0 });
    expect(estimate.estimatedSaved).toBe(0);
    expect(estimate.confidenceRange).toEqual([0, 0]);
  });
});

describe("Output token reduction — ESTIMATED_REDUCTION", () => {
  it("has valid fractions for all levels", () => {
    for (const level of ["lite", "full", "ultra"] as OutputLevel[]) {
      expect(ESTIMATED_REDUCTION[level]).toBeGreaterThan(0);
      expect(ESTIMATED_REDUCTION[level]).toBeLessThan(1);
    }
  });

  it("lite < full < ultra", () => {
    expect(ESTIMATED_REDUCTION.lite).toBeLessThan(ESTIMATED_REDUCTION.full);
    expect(ESTIMATED_REDUCTION.full).toBeLessThan(ESTIMATED_REDUCTION.ultra);
  });
});

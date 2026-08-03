/**
 * Trust guard tests — the most critical safety mechanism in Warden.
 *
 * The guard enforces that pruning only REMOVES content, never rewrites it.
 * Every non-annotation line in the pruned output must appear verbatim in the
 * raw output. These tests verify this invariant holds across edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  verifyInclusion,
  neverWorse,
  isAnnotation,
  annotation,
  WARDEN_MARKER,
} from "../src/pruner/guard.js";

describe("verifyInclusion", () => {
  it("returns true when pruned is a subset of raw", () => {
    const raw = "line1\nline2\nline3\nline4\nline5";
    const pruned = "line1\nline3\nline5";
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("returns true when pruned equals raw", () => {
    const raw = "line1\nline2\nline3";
    expect(verifyInclusion(raw, raw)).toBe(true);
  });

  it("returns true when pruned is empty", () => {
    const raw = "line1\nline2\nline3";
    expect(verifyInclusion(raw, "")).toBe(true);
  });

  it("returns false when pruned contains a line not in raw", () => {
    const raw = "line1\nline2\nline3";
    const pruned = "line1\nline2\nINJECTED";
    expect(verifyInclusion(raw, pruned)).toBe(false);
  });

  it("returns false when a line is altered (rewritten)", () => {
    const raw = "function auth() { return token; }";
    const pruned = "function auth() { return user; }"; // token → user
    expect(verifyInclusion(raw, pruned)).toBe(false);
  });

  it("returns false when a line is partially altered", () => {
    const raw = "Error: something failed at line 42";
    const pruned = "Error: something failed at line 43"; // 42 → 43
    expect(verifyInclusion(raw, pruned)).toBe(false);
  });

  it("allows annotation lines (prefixed with warden marker)", () => {
    const raw = "line1\nline2\nline3";
    const pruned = `line1\n${annotation("2 more lines collapsed")}\nline3`;
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("allows blank lines", () => {
    const raw = "line1\nline2\nline3";
    const pruned = "line1\n\n\nline3";
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("handles Windows line endings (\\r\\n)", () => {
    const raw = "line1\r\nline2\r\nline3";
    const pruned = "line1\nline3";
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("ignores trailing whitespace differences", () => {
    const raw = "line1   \nline2\t\nline3";
    const pruned = "line1\nline2\nline3";
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("detects reordering as valid (order doesn't matter for inclusion)", () => {
    const raw = "line1\nline2\nline3";
    const pruned = "line3\nline1"; // reordered subset
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("handles duplicate lines correctly", () => {
    const raw = "dup\ndup\ndup\nunique";
    const pruned = "dup\nunique";
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("handles empty raw", () => {
    expect(verifyInclusion("", "")).toBe(true);
    expect(verifyInclusion("", "something")).toBe(false);
  });

  it("handles single-line inputs", () => {
    expect(verifyInclusion("only line", "only line")).toBe(true);
    expect(verifyInclusion("only line", "different")).toBe(false);
  });

  it("handles very large inputs", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line${i}`);
    const raw = lines.join("\n");
    const pruned = lines.filter((_, i) => i % 10 === 0).join("\n");
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it("catches a single character change in a large file", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`);
    const raw = lines.join("\n");
    const prunedLines = lines.slice(0, 500);
    prunedLines[250] = "line250X"; // alter one line
    const pruned = prunedLines.join("\n");
    expect(verifyInclusion(raw, pruned)).toBe(false);
  });
});

describe("isAnnotation", () => {
  it("returns true for lines starting with the warden marker", () => {
    expect(isAnnotation(`${WARDEN_MARKER} some text`)).toBe(true);
  });

  it("returns false for regular lines", () => {
    expect(isAnnotation("regular line")).toBe(false);
  });

  it("returns false for empty lines", () => {
    expect(isAnnotation("")).toBe(false);
  });

  it("returns false for lines that contain but don't start with marker", () => {
    expect(isAnnotation(`text ${WARDEN_MARKER} more`)).toBe(false);
  });
});

describe("annotation", () => {
  it("creates a line prefixed with the warden marker", () => {
    const result = annotation("test message");
    expect(result.startsWith(WARDEN_MARKER)).toBe(true);
    expect(isAnnotation(result)).toBe(true);
    expect(result).toContain("test message");
  });
});

describe("neverWorse", () => {
  it("returns true when pruned is smaller than raw", () => {
    expect(neverWorse("a".repeat(100), "a".repeat(50))).toBe(true);
  });

  it("returns true when pruned equals raw", () => {
    expect(neverWorse("a".repeat(100), "a".repeat(100))).toBe(true);
  });

  it("returns false when pruned is larger than raw", () => {
    expect(neverWorse("a".repeat(50), "a".repeat(100))).toBe(false);
  });

  it("returns true for empty pruned output", () => {
    expect(neverWorse("some content", "")).toBe(true);
  });

  it("returns false when annotations inflate output beyond raw", () => {
    const raw = "ab\n";
    const pruned = `${WARDEN_MARKER} very long annotation that makes output bigger than raw\nab\n`;
    expect(neverWorse(raw, pruned)).toBe(false);
  });
});

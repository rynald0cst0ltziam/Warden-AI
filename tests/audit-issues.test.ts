import { describe, it, expect } from "vitest";
import { cleanJson, shortenPaths, rewriteCommand } from "../src/pruner/preprocess.js";
import { isAnnotation, verifyInclusion, WARDEN_MARKER, annotation } from "../src/pruner/guard.js";

describe("audit: JSON cleanup preserves false booleans", () => {
  it("preserves false values (fixed)", () => {
    const input = JSON.stringify({ enabled: false, count: 0, name: "test", active: true });
    const result = cleanJson(input);
    const parsed = JSON.parse(result);
    expect(parsed.enabled).toBe(false);
    expect(parsed.count).toBe(0);
    expect(parsed.active).toBe(true);
  });

  it("preserves empty arrays (fixed)", () => {
    const input = JSON.stringify({ errors: [], warnings: ["none"], data: [1, 2] });
    const result = cleanJson(input);
    const parsed = JSON.parse(result);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual(["none"]);
    expect(parsed.data).toEqual([1, 2]);
  });
});

describe("audit: annotation detection with leading whitespace", () => {
  it("isAnnotation handles leading whitespace (hardened)", () => {
    const line = `  ${WARDEN_MARKER} test annotation`;
    expect(isAnnotation(line)).toBe(true);
  });

  it("isAnnotation works on lines without leading whitespace", () => {
    const line = annotation("test annotation");
    expect(isAnnotation(line)).toBe(true);
  });

  it("verifyInclusion accepts annotated lines with leading whitespace (hardened)", () => {
    const raw = "line1\nline2\nline3";
    const pruned = `line1\n  ${WARDEN_MARKER} collapsed\nline3`;
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });
});

describe("audit: path shortening coverage", () => {
  it("detects standard Unix paths", () => {
    const text = "/Users/alice/project/src/main.ts:1:error here\n/Users/alice/project/src/util.ts:5:warning";
    const result = shortenPaths(text);
    expect(result).not.toContain("/Users/alice/project/");
  });

  it("detects Windows paths", () => {
    const text = "C:\\Users\\alice\\project\\src\\main.ts:1:error\nC:\\Users\\alice\\project\\src\\util.ts:5:warning";
    const result = shortenPaths(text);
    expect(result).not.toContain("C:\\Users\\alice\\project\\");
  });

  it("detects non-standard Unix paths (fixed)", () => {
    const text = "/srv/project/src/main.ts:1:error\n/srv/project/src/util.ts:5:warning";
    const result = shortenPaths(text);
    expect(result).not.toContain("/srv/project/");
  });
});

describe("audit: rewriteCommand preserves error output", () => {
  it("npm install gets --silent", () => {
    expect(rewriteCommand("npm install")).toContain("--silent");
  });

  it("npm test gets --silent", () => {
    expect(rewriteCommand("npm test")).toContain("--silent");
  });

  it("git diff gets --no-color", () => {
    expect(rewriteCommand("git diff")).toContain("--no-color");
  });

  it("does not add flags if already present", () => {
    expect(rewriteCommand("npm install --silent")).toBe("npm install --silent");
  });
});

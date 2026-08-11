/**
 * P3 Git context tests — verifies git history, blame, and change frequency
 * extraction works correctly.
 *
 * These tests create a temporary git repo, commit a few files, and verify
 * that the git context functions return correct data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { gitContext, gitFileHistory, gitChangeFrequency, formatGitContext } from "../src/git/context.js";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-git-test-${Date.now()}`);
const TEST_FILE = "src/example.ts";

function git(args: string[], cwd: string = TEST_DIR): string {
  return execSync("git " + args.map(a => a.includes(" ") ? `"${a}"` : a).join(" "), {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });

  // Init git repo
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);

  // First commit — create file
  writeFileSync(join(TEST_DIR, TEST_FILE), "export function add(a, b) {\n  return a + b;\n}\n");
  git(["add", "."]);
  git(["commit", "-m", "Add add function"]);

  // Second commit — modify file
  writeFileSync(join(TEST_DIR, TEST_FILE), "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n");
  git(["add", "."]);
  git(["commit", "-m", "Add sub function"]);

  // Third commit — modify again
  writeFileSync(join(TEST_DIR, TEST_FILE), "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");
  git(["add", "."]);
  git(["commit", "-m", "Add mul function"]);
}, 60000);

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Git context — file history", () => {
  it("returns commits that touched the file", () => {
    const history = gitFileHistory(TEST_DIR, TEST_FILE, 10);
    expect(history.totalCommits).toBe(3);
    expect(history.commits[0].message).toContain("mul");
    expect(history.commits[2].message).toContain("add");
    expect(history.authors).toContain("Test User");
  }, 15000);

  it("respects limit parameter", () => {
    const history = gitFileHistory(TEST_DIR, TEST_FILE, 2);
    expect(history.totalCommits).toBe(2);
    expect(history.commits[0].message).toContain("mul");
  }, 15000);
});

describe("Git context — change frequency", () => {
  it("calculates churn metrics", () => {
    const freq = gitChangeFrequency(TEST_DIR, TEST_FILE);
    expect(freq.totalCommits).toBe(3);
    expect(freq.linesAdded).toBeGreaterThan(0);
    expect(freq.churnScore).toBeGreaterThan(0);
    expect(freq.lastCommit).not.toBeNull();
  }, 15000);
});

describe("Git context — full context", () => {
  it("returns history and change frequency", () => {
    const ctx = gitContext(TEST_DIR, TEST_FILE);
    expect(ctx.history).toBeDefined();
    expect(ctx.history!.totalCommits).toBe(3);
    expect(ctx.changeFrequency).toBeDefined();
    expect(ctx.changeFrequency!.totalCommits).toBe(3);
  }, 15000);

  it("includes blame when requested", () => {
    const ctx = gitContext(TEST_DIR, TEST_FILE, {
      startLine: 1,
      endLine: 3,
      includeBlame: true,
    });
    expect(ctx.blame).toBeDefined();
    expect(ctx.blame!.length).toBeGreaterThan(0);
    // Blame should return line content
    expect(ctx.blame![0].content).toBeDefined();
    expect(ctx.blame![0].sha).toBeDefined();
  }, 15000);

  it("handles non-existent file gracefully", () => {
    const ctx = gitContext(TEST_DIR, "nonexistent.ts");
    // Should not throw — just return empty/minimal data
    expect(ctx.filePath).toBe("nonexistent.ts");
    expect(ctx.history).toBeUndefined();
    expect(ctx.changeFrequency).toBeUndefined();
  }, 15000);
});

describe("Git context — formatting", () => {
  it("formatGitContext produces readable output", () => {
    const ctx = gitContext(TEST_DIR, TEST_FILE);
    const text = formatGitContext(ctx);
    expect(text).toContain("GIT CONTEXT");
    expect(text).toContain("HISTORY");
    expect(text).toContain("CHANGE FREQUENCY");
    expect(text).toContain("Test User");
  }, 15000);
});

describe("Git context — non-git directory", () => {
  it("returns empty context for non-git directory", () => {
    const nonGitDir = join(tmpdir(), `warden-nongit-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });
    try {
      const ctx = gitContext(nonGitDir, "any.ts");
      expect(ctx.filePath).toBe("any.ts");
      expect(ctx.history).toBeUndefined();
      expect(ctx.changeFrequency).toBeUndefined();
    } finally {
      rmSync(nonGitDir, { recursive: true });
    }
  }, 15000);
});

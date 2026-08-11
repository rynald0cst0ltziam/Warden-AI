/**
 * P4 Sufficient context tests — verifies the unified context layer
 * integrates file recommendations, memory recall, failed approaches,
 * git churn, and token budget trimming.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sufficientContext, formatSufficientContext } from "../src/context/sufficient.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { AgentMemory, type MemoryResult } from "../src/memory/index.js";
import { gitChangeFrequency, type GitChangeFrequency } from "../src/git/context.js";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const TEST_DIR = join(tmpdir(), `warden-sufficient-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");
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

  // Init git repo with multiple commits for churn
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);

  for (let i = 0; i < 6; i++) {
    writeFileSync(
      join(TEST_DIR, TEST_FILE),
      `export function fn${i}(a, b) {\n  return a + b;\n}\n` +
        Array.from({ length: i * 5 }, (_, j) => `// line ${j}`).join("\n") + "\n",
    );
    git(["add", "."]);
    git(["commit", "-m", `Commit ${i}`]);
  }
}, 60000);

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Sufficient context — basic", () => {
  it("returns files from selectContext", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
    });

    expect(result.task).toBe("example function");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0].category).toBeDefined();
    expect(result.files[0].tokens).toBeGreaterThan(0);
  }, 15000);

  it("categorizes files correctly", async () => {
    const result = await sufficientContext({
      task: "example",
      repoRoot: TEST_DIR,
      maxFiles: 5,
    });

    const direct = result.files.find(f => f.filePath.includes("example.ts"));
    expect(direct).toBeDefined();
    expect(direct!.category).toBe("direct");
  }, 15000);
});

describe("Sufficient context — memory integration", () => {
  it("recalls past decisions when memory provider supplied", async () => {
    const store = await SqliteStore.open(TEST_DB);
    const memory = new AgentMemory(store);

    memory.save({
      category: "decision",
      title: "Use example function for testing",
      body: "The example function is the main entry point.",
      tags: ["example", "testing"],
    });

    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      memory: {
        recall: (q, n) => memory.recall(q, n),
        findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
      },
    });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].type).toBe("decision");
    expect(result.memories[0].memory.title).toContain("example");

    store.close();
  }, 15000);

  it("surfaces failed approaches", async () => {
    const store = await SqliteStore.open(TEST_DB);
    const memory = new AgentMemory(store);

    memory.save({
      category: "failed_approach",
      title: "Tried rewriting example function",
      body: "Rewriting caused regressions. Do not retry.",
      tags: ["example"],
      outcome: "failure",
    });

    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      memory: {
        recall: (q, n) => memory.recall(q, n),
        findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
      },
    });

    expect(result.failedApproaches.length).toBeGreaterThan(0);
    expect(result.failedApproaches[0].title).toContain("example");

    store.close();
  }, 15000);
});

describe("Sufficient context — git churn", () => {
  it("enriches files with git churn metrics", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      git: {
        gitChangeFrequency: (root, path) => gitChangeFrequency(root, path),
      },
    });

    const file = result.files.find(f => f.filePath.includes("example.ts"));
    expect(file).toBeDefined();
    expect(file!.gitChurn).toBeDefined();
    expect(file!.gitChurn!.totalCommits).toBe(6);
  }, 15000);

  it("generates volatility notes for high-churn files", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      git: {
        gitChangeFrequency: (root, path) => gitChangeFrequency(root, path),
      },
    });

    // 6 commits > 5 threshold
    expect(result.volatilityNotes.length).toBeGreaterThan(0);
    expect(result.volatilityNotes[0]).toContain("example.ts");
    expect(result.volatilityNotes[0]).toContain("volatile");
  }, 15000);
});

describe("Sufficient context — token budget", () => {
  it("trims package when budget exceeded", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 10,
      tokenBudget: 10, // very small budget — should trim
    });

    expect(result.trimmed).toBe(true);
    expect(result.tokensUsed).toBeLessThanOrEqual(10);
    expect(result.tokensBudget).toBe(10);
  }, 15000);

  it("does not trim when budget is sufficient", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      tokenBudget: 100000, // large budget — should not trim
    });

    expect(result.trimmed).toBe(false);
    expect(result.tokensUsed).toBeGreaterThan(0);
  }, 15000);
});

describe("Sufficient context — formatting", () => {
  it("formatSufficientContext produces readable output", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      git: {
        gitChangeFrequency: (root, path) => gitChangeFrequency(root, path),
      },
    });

    const text = formatSufficientContext(result);
    expect(text).toContain("SUFFICIENT CONTEXT");
    expect(text).toContain("FILES");
    expect(text).toContain("TOKEN ACCOUNTING");
  }, 15000);

  it("formatSufficientContext includes memories when present", async () => {
    const store = await SqliteStore.open(TEST_DB);
    const memory = new AgentMemory(store);

    memory.save({
      category: "decision",
      title: "Use example for testing",
      body: "Example is the main test target.",
      tags: ["example"],
    });

    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      memory: {
        recall: (q, n) => memory.recall(q, n),
        findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
      },
    });

    const text = formatSufficientContext(result);
    expect(text).toContain("PAST DECISIONS");

    store.close();
  }, 15000);

  it("formatSufficientContext includes failed approaches when present", async () => {
    const store = await SqliteStore.open(TEST_DB);
    const memory = new AgentMemory(store);

    memory.save({
      category: "failed_approach",
      title: "Failed rewrite of example",
      body: "Caused regressions.",
      tags: ["example"],
      outcome: "failure",
    });

    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
      memory: {
        recall: (q, n) => memory.recall(q, n),
        findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
      },
    });

    const text = formatSufficientContext(result);
    expect(text).toContain("FAILED APPROACHES");
    expect(text).toContain("WARNING");

    store.close();
  }, 15000);
});

describe("Sufficient context — no providers", () => {
  it("works without memory or git providers", async () => {
    const result = await sufficientContext({
      task: "example function",
      repoRoot: TEST_DIR,
      maxFiles: 5,
    });

    expect(result.memories).toEqual([]);
    expect(result.failedApproaches).toEqual([]);
    expect(result.volatilityNotes).toEqual([]);
    expect(result.files.length).toBeGreaterThan(0);
  }, 15000);
});

/**
 * CLI smoke tests — verify the CLI commands work end-to-end.
 *
 * These run the built CLI (dist/cli.js) as a child process and check
 * that the output contains expected content. They don't test edge cases
 * — just that the commands produce output and don't crash.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(process.cwd(), "dist", "cli.js");

function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  try {
    return execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      timeout: 15000,
      cwd: opts?.cwd ?? process.cwd(),
      env: { ...process.env, ...opts?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // CLI commands that exit with non-zero still produce output
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

describe("CLI smoke tests", () => {
  it("warden status produces output with token savings", () => {
    const output = runCli(["status"]);
    expect(output).toContain("warden");
    expect(output).toContain("tokens saved");
    expect(output).toContain("rules");
  });

  it("warden prune -t grep prunes and reports savings", () => {
    const tmpDir = join(tmpdir(), `warden-cli-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const testFile = join(tmpDir, "test-input.txt");
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`src/file${i}.ts:${i}:noise line ${i}`);
    }
    lines.push("src/auth.ts:42:function auth() { return token; }");
    writeFileSync(testFile, lines.join("\n"));

    try {
      const output = runCli([
        "prune",
        "-t",
        "grep",
        "-i",
        testFile,
        "-m",
        "find auth bug",
      ]);
      // Should contain the auth line (relevant match kept)
      expect(output).toContain("auth");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("warden compress --dry-run produces preview without writing", () => {
    const tmpDir = join(tmpdir(), `warden-compress-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const testFile = join(tmpDir, "test-doc.md");
    const content =
      "# Test\n\nThis is basically just a really simple test document that has some filler words in it.\n";
    writeFileSync(testFile, content);

    try {
      const output = runCli(["compress", testFile, "--dry-run"]);
      expect(output).toContain("tokens");
      expect(output).toContain("reduction");
      // File should NOT be modified (dry run)
      const after = require("node:fs").readFileSync(testFile, "utf8");
      expect(after).toBe(content);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("warden --help lists available commands", () => {
    const output = runCli(["--help"]);
    expect(output).toContain("init");
    expect(output).toContain("serve");
    expect(output).toContain("status");
    expect(output).toContain("prune");
    expect(output).toContain("compress");
  });
});

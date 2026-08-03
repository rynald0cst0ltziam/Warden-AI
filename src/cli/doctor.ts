/**
 * Warden doctor — verifies that Warden is properly installed and working.
 *
 * Checks:
 *   1. MCP server is registered in at least one client config
 *   2. Rules files exist in the project
 *   3. License is activated
 *   4. Pruning engine works (runs a quick self-test)
 *   5. Database is accessible
 *
 * Prints a clear pass/fail report with actionable next steps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { Warden } from "../warden.js";
import { detectAgentConfigs } from "./rules.js";
import { logger } from "../logging/index.js";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

export async function runDoctor(repoRoot: string): Promise<void> {
  const checks: Check[] = [];
  const home = homedir();

  // 1. Check MCP registration in known client configs
  const mcpPaths = [
    { name: "Cursor (global)", path: join(home, ".cursor", "mcp.json") },
    { name: "Claude Code", path: join(home, ".claude.json") },
    { name: "Codex", path: join(home, ".codex", "config.toml") },
    {
      name: "Windsurf/Devin",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
    {
      name: "Devin CLI",
      path:
        process.platform === "win32"
          ? join(home, "AppData", "Roaming", "devin", "config.json")
          : join(home, ".config", "devin", "config.json"),
    },
    { name: "Antigravity", path: join(home, ".gemini", "antigravity", "mcp_config.json") },
    { name: "Antigravity (shared)", path: join(home, ".gemini", "config", "mcp_config.json") },
    { name: "Gemini CLI", path: join(home, ".gemini", "settings.json") },
    { name: "Amazon Q", path: join(home, ".aws", "amazonq", "mcp.json") },
    { name: "Continue", path: join(home, ".continue", "config.json") },
    { name: "Project .mcp.json", path: join(repoRoot, ".mcp.json") },
  ];

  let registeredSomewhere = false;
  for (const mcp of mcpPaths) {
    if (!existsSync(mcp.path)) continue;
    try {
      const content = readFileSync(mcp.path, "utf8");
      if (content.includes("warden")) {
        checks.push({
          name: `MCP registered: ${mcp.name}`,
          passed: true,
          detail: mcp.path,
        });
        registeredSomewhere = true;
      }
    } catch {
      // skip
    }
  }
  if (!registeredSomewhere) {
    checks.push({
      name: "MCP registration",
      passed: false,
      detail: "Warden is not registered in any MCP client config",
      fix: "Run: warden init  (registers Warden in Cursor, Claude Code, Codex, Windsurf, Devin)",
    });
  }

  // 2. Check rules files
  const rulesTargets = detectAgentConfigs(repoRoot);
  const rulesFound = rulesTargets.filter((t) => existsSync(t.path));
  if (rulesFound.length > 0) {
    checks.push({
      name: "Agent rules files",
      passed: true,
      detail: `${rulesFound.length} file(s): ${rulesFound.map((r) => r.agent).join(", ")}`,
    });
  } else {
    checks.push({
      name: "Agent rules files",
      passed: false,
      detail: "No rules files found in project",
      fix: "Run: warden rules  (writes .devin/rules, .cursorrules, CLAUDE.md, AGENTS.md)",
    });
  }

  // 3. License check — Warden is free, honor system
  checks.push({
    name: "License",
    passed: true,
    detail: "Free and open source — no license needed",
    fix: "If Warden saves you tokens, consider donating at https://github.com/rynald0cst0ltziam/Warden-AI",
  });

  // 4. Self-test: run a quick prune and check the engine works
  try {
    const warden = await Warden.create();
    const testOutput = [
      "PASS test auth",
      "PASS test user",
      "PASS test config",
      "FAIL test pruner",
      "  Error: guard check failed at line 42",
      "PASS test classifier",
      "PASS test eval gate",
    ].join("\n");

    const result = await warden.pruneCall({
      toolType: "test-log",
      rawOutput: testOutput,
      taskHint: "fix the failing test",
    });

    const guardOk = result.result.guardOk;
    const saved = result.result.removed.tokensRemoved;

    if (guardOk) {
      checks.push({
        name: "Pruning engine self-test",
        passed: true,
        detail: `Guard OK, ${saved} tokens saved on test input`,
      });
    } else {
      checks.push({
        name: "Pruning engine self-test",
        passed: false,
        detail: "Guard check failed — pruning engine may have a bug",
        fix: "Report this at https://github.com/rynald0cst0ltziam/Warden-AI/issues",
      });
    }

    // 5. Database check
    const status = warden.status();
    checks.push({
      name: "Database",
      passed: true,
      detail: `${status.length} rules tracked, ${warden.totalTokensSaved()} tokens saved total`,
    });

    // 6. Memory system check
    const memories = warden.memory.list(1);
    checks.push({
      name: "Memory system",
      passed: true,
      detail:
        memories.length > 0
          ? `${warden.memory.list().length} memories stored`
          : "ready (no memories saved yet — use warden_memory_save after decisions)",
    });

    // 7. Task outcome tracking check
    const outcomeStats = warden.tracker.stats();
    checks.push({
      name: "Task outcome tracking",
      passed: true,
      detail:
        outcomeStats.total > 0
          ? `${outcomeStats.total} outcomes tracked, ${Math.round(outcomeStats.successRate * 100)}% success rate`
          : "ready (no outcomes recorded yet — use warden_record_outcome after tasks)",
    });

    warden.close();
  } catch (err) {
    checks.push({
      name: "Pruning engine self-test",
      passed: false,
      detail: `Engine error: ${String(err)}`,
      fix: "Try: warden init  (re-initialize the database)",
    });
  }

  // Print report
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  process.stdout.write(
    chalk.bold.cyan("\nwarden doctor — checking your setup\n\n"),
  );

  for (const check of checks) {
    const mark = check.passed ? chalk.green("✓") : chalk.red("✗");
    process.stdout.write(`  ${mark} ${check.name}\n`);
    process.stdout.write(chalk.gray(`      ${check.detail}\n`));
    if (check.fix) {
      process.stdout.write(chalk.yellow(`      → fix: ${check.fix}\n`));
    }
  }

  process.stdout.write(
    chalk.bold.cyan(`\n  ${passed} passed, ${failed} failed\n\n`),
  );

  if (failed === 0) {
    process.stdout.write(
      chalk.green("  Everything looks good. Warden is ready to go.\n") +
        chalk.gray(
          "  Restart your agent to pick up the rules files, then start a session.\n",
        ) +
        chalk.gray(
          "  The agent will print a Warden status line at the start of each session.\n\n",
        ),
    );
  } else {
    process.stdout.write(
      chalk.yellow(
        "  Some checks failed. Run the fixes above, then run `warden doctor` again.\n\n",
      ),
    );
  }
}

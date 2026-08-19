/**
 * Warden CLI.
 *
 *   warden init      — register Warden as an MCP server in detected agent configs
 *   warden serve     — run the Warden MCP server over stdio
 *   warden status    — print a one-shot snapshot of rules + confidence + tokens saved
 *   warden hud       — live, refreshing terminal HUD
 *   warden promote   — promote a rule one stage (shadow → canary → active)
 *   warden revert    — revert a rule to shadow with a reason
 *   warden prune     — run the pruning pipeline on a sample input (smoke test)
 *   warden report    — print the recent audit-trail decisions
 *
 * The CLI shares the same Warden orchestrator as the MCP server, so behavior
 * is identical whether you call it over MCP or from the shell.
 */
import { Command } from "commander";
import chalk from "chalk";
import { Warden } from "../warden.js";
import { runMcpServer } from "../server/mcp.js";
import { runProxy } from "../proxy/index.js";
import { registerEverywhere } from "./register.js";
import { renderHud, renderLive } from "./hud.js";
import { PKG_VERSION } from "../config/index.js";
import { logger } from "../logging/index.js";
import type { ToolType } from "../pruner/types.js";
import { compressFile } from "../compress/index.js";
import type { CompressLevel } from "../compress/index.js";
import { runDashboard } from "../dashboard/index.js";
import {
  setBudgetCap,
  removeBudgetCap,
  listBudgetCaps,
  budgetReport,
} from "../budget/index.js";
import { exportAuditTrail, type ExportFormat } from "../audit/export.js";
import { runWatchdogTiered, watchdogMode } from "../watchdog/index.js";
import { writeRules, writeGlobalRules, detectAgentConfigs } from "./rules.js";
import { installHooks } from "./hooks.js";
import { DEFAULT_OUTPUT_LEVEL, type OutputLevel } from "../output/index.js";
import { runDoctor } from "./doctor.js";
import { ccrSummary, ccrCleanup } from "../ccr/index.js";
import { buildTaskReport, formatTaskReport, buildProjectReport } from "../measurement/report.js";
import { gitContext, formatGitContext } from "../git/context.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const TOOL_TYPES: ToolType[] = [
  "grep",
  "search",
  "file-read",
  "test-log",
  "web-fetch",
  "json",
  "generic",
];

function fail(msg: string): never {
  process.stderr.write(chalk.red(`error: ${msg}\n`));
  process.exit(1);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("warden")
    .description(
      "The structurally-verified context layer for AI coding agents.",
    )
    .version(PKG_VERSION);

  program
    .command("init")
    .description(
      "Set up Warden: register as MCP server, write agent rules, build code index, compress memory files. Everything is active after this one command.",
    )
    .option("-c, --command <cmd>", "Command to invoke Warden with", "warden")
    .option("--skip-index", "Skip code indexing (faster, but graph tools won't work until `warden index`)")
    .option("--skip-compress", "Skip compressing memory/rules files")
    .action(async (opts: { command: string; skipIndex?: boolean; skipCompress?: boolean }) => {
      const lines = [chalk.bold.cyan("\nwarden init — setting up Warden\n")];

      // Step 1: Register MCP server in all detected agents
      lines.push(chalk.bold("Step 1: Register MCP server\n"));
      const targets = registerEverywhere(opts.command);
      for (const t of targets) {
        const mark = t.registered ? chalk.green("✓") : chalk.gray("•");
        const note = t.note ? chalk.gray(` (${t.note})`) : "";
        lines.push(`  ${mark} ${t.agent.padEnd(16)} ${t.path}${note}`);
      }

      // Step 2: Write agent rules files (project-level + global)
      lines.push("", chalk.bold("Step 2: Write agent rules files\n"));
      const rulesTargets = writeRules(process.cwd());
      const writtenRules = rulesTargets.filter((t) => t.written);
      for (const t of rulesTargets) {
        const mark = t.written ? chalk.green("✓") : chalk.red("✗");
        lines.push(`  ${mark} ${t.agent.padEnd(16)} ${t.path}`);
      }

      // Step 2b: Write global rules (apply to all projects)
      lines.push("", chalk.bold("Step 2b: Write global rules (all projects)\n"));
      const globalTargets = writeGlobalRules();
      for (const t of globalTargets) {
        const mark = t.written ? chalk.green("✓") : chalk.red("✗");
        lines.push(`  ${mark} ${t.agent.padEnd(22)} ${t.path}`);
      }

      // Step 2c: Install PreToolUse hooks (enforce Warden wrapper usage)
      lines.push("", chalk.bold("Step 2c: Install enforcement hooks\n"));
      lines.push(chalk.gray("  PreToolUse hooks block built-in Read/Grep calls and redirect to Warden wrappers.\n"));
      const hookTargets = installHooks(process.cwd(), opts.command);
      for (const t of hookTargets) {
        const mark = t.written ? chalk.green("✓") : chalk.red("✗");
        const note = t.note ? chalk.gray(` (${t.note})`) : "";
        lines.push(`  ${mark} ${t.agent.padEnd(16)} ${t.path}${note}`);
      }

      // Step 3: Build code index (enables call graph, impact analysis, architecture overview)
      let indexResult: { filesParsed: number; symbolsFound: number; durationMs: number } | null = null;
      if (!opts.skipIndex) {
        lines.push("", chalk.bold("Step 3: Build code index\n"));
        try {
          const { CodeIndex } = await import("../index/indexer.js");
          const warden = await Warden.create();
          try {
            const repoRoot = warden.repoRoot ?? process.cwd();
            const indexer = new CodeIndex(warden.store);
            const result = await indexer.index({ repoRoot, maxFiles: 10000 });
            indexResult = { filesParsed: result.filesParsed, symbolsFound: result.symbolsFound, durationMs: result.durationMs };
            lines.push(
              chalk.green(`  ✓ ${result.filesParsed}/${result.filesScanned} files parsed`),
              chalk.gray(`    ${result.symbolsFound} symbols, ${result.importsFound} imports, ${result.callsFound} calls (${result.durationMs}ms)`),
            );
          } finally {
            warden.close();
          }
        } catch (err) {
          lines.push(chalk.yellow(`  ⚠ index skipped: ${String(err)}`));
          lines.push(chalk.gray("    Run `warden index` manually later to enable graph tools."));
        }
      } else {
        lines.push("", chalk.gray("Step 3: Code index skipped (--skip-index)\n"));
      }

      // Step 4: Compress memory/rules files (saves tokens every future session)
      if (!opts.skipCompress) {
        lines.push("", chalk.bold("Step 4: Compress memory files\n"));
        const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
        const { resolve, basename } = await import("node:path");
        const compressTargets = [
          "CLAUDE.md", "AGENTS.md", ".cursorrules", ".clinerules",
          ".continuerules", "GEMINI.md", ".zedrules",
          ".github/copilot-instructions.md",
          "CONVENTIONS.md", ".mcprules",
        ];
        let compressedCount = 0;
        let totalSaved = 0;
        for (const target of compressTargets) {
          const filePath = resolve(process.cwd(), target);
          if (!existsSync(filePath)) continue;
          const original = readFileSync(filePath, "utf8");
          const result = compressFile(original, "full");
          if (!result.validationOk || result.reductionPct <= 0) {
            lines.push(chalk.gray(`  • ${target.padEnd(20)} already compact (${result.tokensBefore} tokens)`));
            continue;
          }
          const backupPath = `${filePath}.original`;
          if (!existsSync(backupPath)) writeFileSync(backupPath, original);
          writeFileSync(filePath, result.compressed);
          compressedCount++;
          totalSaved += result.tokensBefore - result.tokensAfter;
          lines.push(
            chalk.green(`  ✓ ${target.padEnd(20)} ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.reductionPct}% reduction)`),
          );
        }
        if (compressedCount === 0) {
          lines.push(chalk.gray("  • No compressible memory files found"));
        } else {
          lines.push(chalk.gray(`\n  ${compressedCount} files compressed, ${totalSaved} tokens saved per session`));
        }
      } else {
        lines.push("", chalk.gray("Step 4: Memory compression skipped (--skip-compress)\n"));
      }

      // Step 5: Summary
      const registeredCount = targets.filter((t) => t.registered).length;
      const globalWrittenCount = globalTargets.filter((t) => t.written).length;
      lines.push(
        "",
        chalk.bold("You're done.\n"),
        chalk.gray("  Warden is registered in "),
        chalk.bold(`${registeredCount}`),
        chalk.gray(" agent(s)."),
        chalk.gray(`  ${writtenRules.length} project rules + ${globalWrittenCount} global rules written.`),
        indexResult
          ? chalk.gray(`  Code index: ${indexResult.filesParsed} files, ${indexResult.symbolsFound} symbols.`)
          : chalk.gray("  Code index: skipped."),
        "",
        chalk.gray("  Everything is active by default:\n"),
        chalk.gray("  • 4/4 pruning rules live (grep, file-read, test-log, generic)\n"),
        chalk.gray("  • Output compression rules in every agent\n"),
        chalk.gray("  • Code intelligence ready (call graph, impact, architecture)\n"),
        chalk.gray("  • Memory system ready (save/recall across sessions)\n"),
        chalk.gray("  • Trust guard verifying every prune\n"),
        "",
        chalk.gray("  Just restart your IDE and start working normally.\n"),
        chalk.gray("  Warden runs automatically — no commands to remember.\n"),
        "",
        chalk.gray("  What you'll see in your IDE:\n"),
        chalk.gray("  • Session start: \"Warden active — X tokens saved, Y rules live\"\n"),
        chalk.gray("  • Every tool call: ‹warden› annotation showing tokens saved\n"),
        chalk.gray("  • After each task: cumulative savings summary\n"),
        "",
        chalk.gray("  Optional commands:\n"),
        chalk.gray("  • warden status     — detailed savings breakdown\n"),
        chalk.gray("  • warden dashboard  — web UI at localhost:7878\n"),
        chalk.gray("  • warden doctor     — verify everything is set up correctly\n"),
        chalk.gray("  • warden hud        — live terminal HUD\n"),
        "",
      );
      process.stdout.write(lines.join("\n") + "\n");
    });

  program
    .command("rules")
    .description(
      "Write agent rules files that tell your AI agent to always use Warden's wrapper tools (warden_grep, warden_file_read, etc.) instead of built-in ones. This makes pruning automatic — no manual step needed.",
    )
    .action(() => {
      const repoRoot = process.cwd();
      const targets = writeRules(repoRoot, DEFAULT_OUTPUT_LEVEL);
      process.stdout.write(
        chalk.bold.cyan(`\nwarden rules — writing agent instruction files\n\n`),
      );
      for (const t of targets) {
        const mark = t.written ? chalk.green("✓") : chalk.red("✗");
        process.stdout.write(`  ${mark} ${t.agent.padEnd(16)} ${t.path}\n`);
      }
      process.stdout.write(
        chalk.gray(
          `\n  Output compression: max (automatic, no config needed)\n`,
        ) +
          chalk.gray(
            "  Your agent will now automatically use Warden's wrapper tools.\n",
          ) +
          chalk.gray("  Restart your agent to pick up the new rules.\n\n"),
      );
    });

  program
    .command("doctor")
    .description(
      "Verify Warden is properly installed: MCP registration, rules files, engine self-test.",
    )
    .action(async () => {
      await runDoctor(process.cwd());
    });

  program
    .command("serve")
    .description(
      "Run the Warden MCP server over stdio (called by MCP clients).",
    )
    .action(async () => {
      await runMcpServer();
    });

  program
    .command("proxy", { isDefault: false })
    .description(
      "MCP proxy middleware. Wraps an upstream MCP server and compresses tool descriptions to save context tokens. Usage: warden proxy <command> [...args]",
    )
    .argument("<command>", "Upstream MCP server command (e.g. npx, node)")
    .argument("[args...]", "Arguments for the upstream command")
    .option("--fields <fields>", "Comma-separated field names to compress (default: description)")
    .option("--level <level>", "Compression level: lite, full, ultra (default: full)")
    .option("--debug", "Log compression deltas to stderr")
    .action(async (command: string, args: string[], opts: {
      fields?: string;
      level?: string;
      debug?: boolean;
    }) => {
      const fields = opts.fields?.split(",").map((s) => s.trim()).filter(Boolean);
      const validLevels = ["lite", "full", "ultra"];
      if (opts.level && !validLevels.includes(opts.level)) {
        process.stderr.write(`Invalid --level "${opts.level}". Must be one of: ${validLevels.join(", ")}\n`);
        process.exit(1);
      }
      await runProxy(command, args, {
        fields,
        level: opts.level as "lite" | "full" | "ultra" | undefined,
        debug: opts.debug,
      });
    });

  program
    .command("hook")
    .description(
      "Hook handler for agent PreToolUse interception. Reads JSON from stdin, blocks built-in Read/Grep calls and redirects to Warden wrappers. Used by hook configs installed by `warden init`.",
    )
    .argument("<action>", "Hook action: 'redirect' to intercept built-in tools")
    .action(async (action: string) => {
      if (action !== "redirect") {
        process.stderr.write(`Unknown hook action: ${action}\n`);
        process.exit(1);
      }

      // Read JSON from stdin (tool_name + tool_input from the agent)
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
      }

      let toolName = "";
      try {
        const data = JSON.parse(input);
        toolName = data.tool_name ?? data.toolName ?? "";
      } catch {
        // Can't parse — allow the call (fail open)
        process.exit(0);
      }

      // Normalize tool name for matching (case-insensitive)
      const normalized = toolName.toLowerCase();

      // Don't intercept Warden's own MCP tools
      if (normalized.includes("warden") || normalized.includes("mcp__")) {
        process.exit(0);
      }

      // Don't intercept write/edit operations (Warden has no wrappers for these)
      const writeTools = ["write", "edit", "notebook_edit", "create_file", "multi_edit"];
      if (writeTools.some((t) => normalized.includes(t))) {
        process.exit(0);
      }

      // Intercept Read → redirect to warden_file_read
      if (normalized === "read" || normalized === "read_file" || normalized === "fileread") {
        process.stderr.write(
          "BLOCKED: Use warden_file_read instead of the built-in Read tool. " +
          "warden_file_read does the same thing AND prunes the output (50-90% token reduction). " +
          "Call: warden_file_read({ filePath: \"<path>\" })\n",
        );
        process.exit(2);
      }

      // Intercept Grep/Search → redirect to warden_grep
      if (normalized === "grep" || normalized === "search" || normalized === "code_search") {
        process.stderr.write(
          "BLOCKED: Use warden_grep instead of the built-in Grep/Search tool. " +
          "warden_grep does the same thing AND prunes the output (50-90% token reduction). " +
          "Call: warden_grep({ pattern: \"<pattern>\" })\n",
        );
        process.exit(2);
      }

      // Allow everything else (Bash, exec, etc. — too many edge cases to block)
      process.exit(0);
    });

  program
    .command("status")
    .description(
      "Print a one-shot snapshot of rules, confidence, and tokens saved.",
    )
    .action(async () => {
      const warden = await Warden.create();
      try {
        process.stdout.write((await renderHud(warden)) + "\n");
      } finally {
        warden.close();
      }
    });

  program
    .command("hud")
    .description("Live, refreshing terminal HUD (Ctrl+C to exit).")
    .option("-i, --interval <ms>", "Refresh interval in milliseconds", "2000")
    .action(async (opts: { interval: string }) => {
      const ms = Number.parseInt(opts.interval, 10);
      if (Number.isNaN(ms) || ms < 500) fail("--interval must be >= 500ms");
      const warden = await Warden.create();
      await renderLive(warden, ms);
    });

  program
    .command("promote")
    .description("Promote a pruning rule one stage (shadow → canary → active).")
    .argument("<ruleId>", "The rule id (see `warden status`).")
    .option(
      "-f, --force",
      "Promote even if confidence/samples thresholds aren't met.",
    )
    .action(async (ruleId: string, opts: { force: boolean }) => {
      const warden = await Warden.create();
      try {
        const decision = warden.gate.promote(ruleId, opts.force);
        if (decision.eligible) {
          process.stdout.write(
            chalk.green(
              `✓ promoted ${ruleId}: ${decision.from} → ${decision.to}\n`,
            ) + chalk.gray(`  reason: ${decision.reason}\n`),
          );
        } else {
          process.stdout.write(
            chalk.yellow(`✗ not eligible: ${decision.reason}\n`) +
              chalk.gray(`  (use --force to override)\n`),
          );
          process.exit(1);
        }
      } finally {
        warden.close();
      }
    });

  program
    .command("revert")
    .description("Revert a pruning rule to shadow with a reason.")
    .argument("<ruleId>", "The rule id (see `warden status`).")
    .argument("<reason>", "Why this rule is being reverted.")
    .action(async (ruleId: string, reason: string) => {
      const warden = await Warden.create();
      try {
        warden.gate.revert(ruleId, reason);
        process.stdout.write(chalk.red(`↩ reverted ${ruleId}: ${reason}\n`));
      } finally {
        warden.close();
      }
    });

  program
    .command("prune")
    .description(
      "Run the pruning pipeline on a sample input (smoke test / demo).",
    )
    .option("-t, --tool-type <type>", "Tool type", "grep")
    .option(
      "-i, --input <file>",
      "Read raw input from a file (default: stdin).",
    )
    .option("-m, --message <text>", "User message for task classification.", "")
    .option("-h, --hint <text>", "Relevance hint (overrides classifier).")
    .action(
      async (opts: {
        toolType: string;
        input?: string;
        message: string;
        hint?: string;
      }) => {
        const toolType = opts.toolType as ToolType;
        if (!TOOL_TYPES.includes(toolType))
          fail(`invalid --tool-type: ${opts.toolType}`);
        let raw: string;
        if (opts.input) {
          const { readFileSync } = await import("node:fs");
          raw = readFileSync(opts.input, "utf8");
        } else if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
          raw = Buffer.concat(chunks).toString("utf8");
        } else {
          fail("no input: pass --input <file> or pipe via stdin");
        }
        const warden = await Warden.create();
        try {
          const res = await warden.pruneCall({
            toolType,
            rawOutput: raw,
            userMessage: opts.message,
            taskHint: opts.hint,
          });
          // Badge goes to stdout BEFORE the content (visible first)
          const { buildWardenMeta, formatWardenAnnotation, formatWardenBadge, formatWardenCcr, formatWardenMetaJson } = await import("../pruner/types.js");
          const { extractCcrMarker } = await import("../ccr/index.js");
          const ccrHash = extractCcrMarker(res.shipped);
          const meta = buildWardenMeta({
            result: res.result,
            stage: res.stage,
            applied: res.applied,
            ccrHash,
          });
          // Badge to stdout (before content)
          const badgeLines = [
            formatWardenBadge(meta),
            `‹warden› ${res.result.removed.summary}`,
          ];
          if (ccrHash) badgeLines.push(formatWardenCcr(ccrHash));
          process.stdout.write(badgeLines.join("\n") + "\n\n");
          process.stdout.write(res.shipped + "\n");
          // Compact annotation + meta JSON to stderr (for machine parsing)
          process.stderr.write(
            chalk.gray(
              `\n${formatWardenAnnotation(meta)}\n` +
                `${formatWardenMetaJson(meta)}\n`,
            ),
          );
        } finally {
          warden.close();
        }
      },
    );

  program
    .command("report")
    .description("Print the recent audit-trail decisions.")
    .option("-n, --limit <n>", "Number of decisions to show.", "20")
    .action(async (opts: { limit: string }) => {
      const n = Number.parseInt(opts.limit, 10);
      if (Number.isNaN(n) || n < 1) fail("--limit must be a positive integer");
      const warden = await Warden.create();
      try {
        const decisions = warden.store.recentDecisions(n);
        if (decisions.length === 0) {
          process.stdout.write(chalk.gray("(no decisions yet)\n"));
          return;
        }
        for (const d of decisions) {
          let detail: Record<string, unknown>;
          try {
            detail = JSON.parse(d.detail_json) as Record<string, unknown>;
          } catch {
            detail = { detail: d.detail_json };
          }
          process.stdout.write(
            `${chalk.gray(d.timestamp)} ${d.kind.padEnd(8)} ${d.rule_id ?? "-".padEnd(36)} ` +
              `saved=${d.tokens_saved} ${chalk.gray(JSON.stringify(detail))}\n`,
          );
        }
      } finally {
        warden.close();
      }
    });

  // ---- task-report command (P0a measurement) ----

  program
    .command("task-report")
    .description(
      "Show a task performance report: tokens saved, reduction %, guard results, task outcomes for a time range.",
    )
    .option("--since <iso>", "Start time (ISO 8601). Defaults to 24h ago.")
    .option("--until <iso>", "End time (ISO 8601). Defaults to now.")
    .option("--task <filter>", "Filter outcomes by task description (substring).")
    .option("--all", "Show project-wide historical report instead of time range.")
    .action(async (opts: { since?: string; until?: string; task?: string; all?: boolean }) => {
      const warden = await Warden.create();
      try {
        if (opts.all) {
          const report = buildProjectReport(warden.store);
          const lines = [
            "WARDEN PROJECT REPORT — ALL TIME",
            "────────────────────────────────────────",
            "",
            `Total prune calls:     ${report.totalPruneCalls.toLocaleString()}`,
            `Tokens processed:      ${report.totalTokensProcessed.toLocaleString()}`,
            `Tokens saved (gross):  ${report.totalTokensSaved.toLocaleString()}`,
            `Reduction:             ${report.reductionPct}%`,
            "",
            `Total tasks tracked:   ${report.totalTasks}`,
            `Successful:            ${report.successfulTasks}`,
            `Failed:                ${report.failedTasks}`,
            `Success rate:          ${(report.successRate * 100).toFixed(1)}%`,
            "",
            `CCR cached originals:  ${report.ccrCount}`,
            `CCR tokens retrievable: ${report.ccrTokensRetrievable.toLocaleString()}`,
            "",
          ];
          if (report.recentOutcomes.length > 0) {
            lines.push("RECENT TASK OUTCOMES");
            for (const o of report.recentOutcomes) {
              const status = o.success ? "SUCCESS" : "FAILURE";
              const pruned = o.pruned ? "pruned" : "raw";
              lines.push(
                `  [${status.padEnd(7)}] ${o.task} (${pruned}, saved=${o.tokensSaved})`,
              );
            }
            lines.push("");
          }
          lines.push("────────────────────────────────────────");
          lines.push(`Total tokens avoided: ${report.totalTokensSaved.toLocaleString()}`);
          process.stdout.write(lines.join("\n") + "\n");
        } else {
          const end = opts.until ?? new Date().toISOString();
          const start = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const report = buildTaskReport(warden.store, {
            start,
            end,
            taskFilter: opts.task,
          });
          process.stdout.write(formatTaskReport(report) + "\n");
        }
      } finally {
        warden.close();
      }
    });

  // ---- git-context command (P3) ----

  program
    .command("git-context <file>")
    .description("Show git history, blame, and change frequency for a file.")
    .option("-s, --start <line>", "Start line for blame (1-based).")
    .option("-e, --end <line>", "End line for blame (1-based).")
    .option("-b, --blame", "Include line-level blame (slower).")
    .option("-r, --repo <root>", "Repository root (defaults to cwd).")
    .action(async (file: string, opts: { start?: string; end?: string; blame?: boolean; repo?: string }) => {
      const root = opts.repo ?? process.cwd();
      const ctx = gitContext(root, file, {
        startLine: opts.start ? parseInt(opts.start, 10) : undefined,
        endLine: opts.end ? parseInt(opts.end, 10) : undefined,
        includeBlame: opts.blame,
      });
      process.stdout.write(formatGitContext(ctx) + "\n");
    });

  // ---- dashboard command ----

  program
    .command("dashboard")
    .description("Run the local Warden dashboard web UI.")
    .option("-p, --port <port>", "Port number", "7878")
    .option("-h, --host <host>", "Host to bind", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
      await runDashboard({ port: parseInt(opts.port, 10), host: opts.host });
    });

  // ---- budget commands ----

  const budgetCmd = program
    .command("budget")
    .description("Manage token budget caps.");

  budgetCmd
    .command("set <scope> <tokens>")
    .description("Set a budget cap. Scope: 'seat:<email>' or 'project:<name>'.")
    .option("-d, --days <n>", "Billing period in days", "30")
    .action((scope: string, tokens: string, opts: { days: string }) => {
      try {
        setBudgetCap(scope, parseInt(tokens, 10), parseInt(opts.days, 10));
        process.stdout.write(
          chalk.green(
            `✓ budget cap set: ${scope} = ${tokens} tokens / ${opts.days} days\n`,
          ),
        );
      } catch (err) {
        fail(String(err));
      }
    });

  budgetCmd
    .command("remove <scope>")
    .description("Remove a budget cap.")
    .action((scope: string) => {
      removeBudgetCap(scope);
      process.stdout.write(chalk.gray(`✓ removed budget cap for ${scope}\n`));
    });

  budgetCmd
    .command("list")
    .description("List all budget caps and current usage.")
    .action(() => {
      const report = budgetReport();
      if (report.length === 0) {
        process.stdout.write(chalk.gray("  No budget caps configured.\n"));
        return;
      }
      for (const b of report) {
        const pct = ((b.spent / b.cap) * 100).toFixed(1);
        const status = b.exceeded ? chalk.red("EXCEEDED") : chalk.green("OK");
        process.stdout.write(
          `  ${b.scope.padEnd(30)} ${String(b.spent).padStart(10)} / ${String(b.cap).padStart(10)} (${pct}%) ${status}\n`,
        );
      }
    });

  // ---- export command ----

  program
    .command("export")
    .description("Export the audit trail.")
    .option("-f, --format <format>", "Export format: json or csv", "json")
    .option("-o, --output <file>", "Output file path (default: stdout)")
    .option("-r, --rule <ruleId>", "Filter by rule id")
    .option(
      "-k, --kind <kind>",
      "Filter by kind (prune/promote/revert/observe)",
    )
    .option("-n, --limit <n>", "Max records", "10000")
    .action(
      async (opts: {
        format: string;
        output?: string;
        rule?: string;
        kind?: string;
        limit: string;
      }) => {
        const warden = await Warden.create();
        try {
          const result = exportAuditTrail(warden.store, {
            format: opts.format as ExportFormat,
            outputPath: opts.output,
            ruleId: opts.rule,
            kind: opts.kind,
            limit: parseInt(opts.limit, 10),
          });
          if (result.content) {
            process.stdout.write(result.content + "\n");
          } else {
            process.stdout.write(
              chalk.green(
                `✓ exported ${result.recordCount} records to ${result.filePath}\n`,
              ),
            );
          }
        } catch (err) {
          fail(String(err));
        } finally {
          warden.close();
        }
      },
    );

  // ---- compress command ----

  program
    .command("compress")
    .description(
      "Compress a markdown/text file — strips filler, preserves code/paths/commands verbatim. Max compression, always.",
    )
    .argument("<file>", "File to compress (e.g., CLAUDE.md, AGENTS.md)")
    .option(
      "-o, --output <file>",
      "Output file path (default: overwrite in place)",
    )
    .option("--dry-run", "Show what would be compressed without writing")
    .action(
      async (
        file: string,
        opts: { output?: string; dryRun?: boolean },
      ) => {
        const { readFileSync, writeFileSync, existsSync } =
          await import("node:fs");
        const { resolve, basename } = await import("node:path");

        const filePath = resolve(file);
        if (!existsSync(filePath)) {
          fail(`File not found: ${filePath}`);
        }

        const level: CompressLevel = "ultra";
        const original = readFileSync(filePath, "utf8");
        const result = compressFile(original, level);

        if (!result.validationOk) {
          console.error(
            chalk.red("✗ compression validation failed — not writing:"),
          );
          for (const err of result.validationErrors) {
            console.error(chalk.red(`  ${err}`));
          }
          fail("Validation failed — file not modified.");
        }

        const outPath = opts.output ? resolve(opts.output) : filePath;

        if (opts.dryRun) {
          console.log(
            chalk.cyan(`warden compress — ${basename(filePath)} (${level})`),
          );
          console.log(
            `  ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.reductionPct}% reduction)`,
          );
          console.log(
            `  ${result.preservedSegments} segments preserved verbatim`,
          );
          console.log(`  validation: ${result.validationOk ? "✓" : "✗"}`);
          console.log("");
          console.log(chalk.gray("--- compressed output ---"));
          console.log(result.compressed);
          return;
        }

        // Back up original if overwriting in place
        if (!opts.output && existsSync(filePath)) {
          const backupPath = `${filePath}.original`;
          if (!existsSync(backupPath)) {
            writeFileSync(backupPath, original);
            console.log(chalk.gray(`  backup: ${backupPath}`));
          }
        }

        writeFileSync(outPath, result.compressed);
        console.log(
          chalk.green(
            `✓ compressed ${basename(filePath)}: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.reductionPct}% reduction)`,
          ),
        );
        console.log(
          chalk.gray(
            `  ${result.preservedSegments} segments preserved verbatim, validation: ✓`,
          ),
        );
      },
    );

  // ---- watchdog command ----

  program
    .command("watchdog")
    .description(
      "Run the regression watchdog (checks active rules for quality regressions).",
    )
    .action(async () => {
      const warden = await Warden.create();
      try {
        const mode = watchdogMode();
        process.stdout.write(
          chalk.cyan(`\n  Warden Watchdog — mode: ${mode}\n`) +
            chalk.gray("  ============================================\n\n"),
        );
        const result = await runWatchdogTiered(warden);
        for (const c of result.checked) {
          const conf = Number.isNaN(c.confidence)
            ? "  —"
            : (c.confidence * 100).toFixed(0);
          let icon = chalk.green("✓");
          let note = "ok";
          if (c.action === "reverted") {
            icon = chalk.red("↩");
            note = `REVERTED: ${c.reason}`;
          } else if (c.action === "alerted") {
            icon = chalk.yellow("⚠");
            note = c.reason ?? "alerted";
          }
          process.stdout.write(
            `  ${icon} ${c.ruleId.padEnd(36)} ${c.stage.padEnd(8)} conf=${conf}% samples=${c.samples}  ${note}\n`,
          );
        }
        if (result.reverted) {
          process.stdout.write(
            chalk.red(
              "\n  ⚠ Auto-reverted rules detected. Check `warden report` for details.\n",
            ),
          );
        }
        if (result.alerted && !result.reverted) {
          process.stdout.write(
            chalk.yellow(
              "\n  ⚠ Alerts fired. Check `warden report` for details.\n",
            ),
          );
        }
        if (result.checked.length === 0) {
          process.stdout.write(chalk.gray("  No rules to check.\n"));
        }
        process.stdout.write("\n");
      } finally {
        warden.close();
      }
    });

  // ---- memory commands ----
  program
    .command("memory")
    .description("Manage project memories (decisions, findings, patterns)")
    .argument("<action>", "save | recall | list | forget")
    .option("-t, --title <title>", "Memory title (for save)")
    .option("-b, --body <body>", "Memory body (for save)")
    .option(
      "-c, --category <category>",
      "Memory category (for save)",
      "decision",
    )
    .option("--tags <tags>", "Comma-separated tags (for save)")
    .option("-q, --query <query>", "Search query (for recall)")
    .option("-i, --id <id>", "Memory ID (for forget)")
    .option("--limit <n>", "Max results", "10")
    .action(async (action, opts) => {
      const warden = await Warden.create();
      try {
        if (action === "save") {
          if (!opts.title || !opts.body) {
            process.stderr.write("save requires --title and --body\n");
            process.exit(1);
          }
          const tags = opts.tags
            ? opts.tags.split(",").map((t: string) => t.trim())
            : [];
          const id = warden.memory.save({
            category: opts.category,
            title: opts.title,
            body: opts.body,
            tags,
          });
          process.stdout.write(
            chalk.green(
              `Memory saved (id=${id}): [${opts.category}] ${opts.title}\n`,
            ),
          );
        } else if (action === "recall") {
          if (!opts.query) {
            process.stderr.write("recall requires --query\n");
            process.exit(1);
          }
          const results = warden.memory.recall(
            opts.query,
            parseInt(opts.limit, 10),
          );
          if (results.length === 0) {
            process.stdout.write(
              chalk.gray(`No memories found for "${opts.query}"\n`),
            );
          } else {
            for (const m of results) {
              process.stdout.write(
                `  ${chalk.cyan(`#${m.id}`)} [${m.category}] ${chalk.bold(m.title)}\n` +
                  `    ${chalk.gray(m.body)}\n` +
                  `    ${chalk.gray(`tags: ${m.tags.join(", ") || "none"} | accessed: ${m.accessCount}x | ${m.timestamp.slice(0, 10)}`)}\n\n`,
              );
            }
          }
        } else if (action === "list") {
          const results = warden.memory.list(parseInt(opts.limit, 10));
          if (results.length === 0) {
            process.stdout.write(chalk.gray("No memories stored yet.\n"));
          } else {
            for (const m of results) {
              process.stdout.write(
                `  ${chalk.cyan(`#${m.id}`)} [${m.category}] ${chalk.bold(m.title)}  ${chalk.gray(`(${m.timestamp.slice(0, 10)}, accessed ${m.accessCount}x)`)}\n`,
              );
            }
          }
        } else if (action === "forget") {
          if (!opts.id) {
            process.stderr.write("forget requires --id\n");
            process.exit(1);
          }
          const deleted = warden.memory.forget(parseInt(opts.id, 10));
          process.stdout.write(
            deleted
              ? chalk.green(`Memory #${opts.id} deleted.\n`)
              : chalk.red(`Memory #${opts.id} not found.\n`),
          );
        } else {
          process.stderr.write(
            `Unknown action: ${action}. Use save, recall, list, or forget.\n`,
          );
          process.exit(1);
        }
      } finally {
        warden.close();
      }
    });

  // ---- context select command ----
  program
    .command("context")
    .description("Scan the project and extract relevant code for a given task")
    .argument("<task>", "Task description")
    .option("-r, --root <path>", "Project root (defaults to cwd)")
    .option("-n, --max-files <n>", "Max files to include", "10")
    .action(async (task, opts) => {
      const { selectContext } = await import("../context/index.js");
      const result = await selectContext({
        task,
        repoRoot: opts.root ?? process.cwd(),
        maxFiles: parseInt(opts.maxFiles, 10),
      });
      process.stdout.write(
        chalk.bold(
          `\n  Warden context selection — ${result.package.length} files`,
        ) +
          chalk.gray(
            `  (${result.reductionPct}% smaller than reading full files)\n`,
          ),
      );
      process.stdout.write(
        chalk.gray(
          `  full: ~${result.tokensFull} tokens → compact: ~${result.tokensCompact} tokens\n\n`,
        ),
      );

      for (const file of result.package) {
        process.stdout.write(
          chalk.cyan(`  ── ${file.filePath} `) +
            chalk.gray(
              `(${file.totalLines} lines, showing ${file.linesIncluded})\n`,
            ),
        );
        for (const slice of file.slices) {
          process.stdout.write(
            chalk.gray(
              `  [lines ${slice.startLine}-${slice.endLine}] ${slice.reason}:\n`,
            ),
          );
          for (const codeLine of slice.code.split("\n")) {
            process.stdout.write(`  ${codeLine}\n`);
          }
        }
        if (file.outline.length > 0) {
          process.stdout.write(
            chalk.gray(
              `  … outline (${file.outline.length} more blocks not shown):\n`,
            ),
          );
          for (const ol of file.outline) {
            process.stdout.write(chalk.gray(`    L${ol.line}: ${ol.header}\n`));
          }
        }
        process.stdout.write("\n");
      }
    });

  // ---- sufficient context command (P4) ----
  program
    .command("sufficient-context")
    .description("Get unified context: files + past decisions + failed approaches + git volatility")
    .argument("<task>", "Task description")
    .option("-r, --root <path>", "Project root (defaults to cwd)")
    .option("-n, --max-files <n>", "Max files to include", "15")
    .option("-b, --budget <tokens>", "Token budget (trims package to fit)")
    .option("--memory-limit <n>", "Max past decisions to recall", "5")
    .option("--failed-limit <n>", "Max failed approaches to surface", "3")
    .action(async (task, opts: { root?: string; maxFiles?: string; budget?: string; memoryLimit?: string; failedLimit?: string }) => {
      const { sufficientContext, formatSufficientContext } = await import("../context/sufficient.js");
      const { gitChangeFrequency } = await import("../git/context.js");
      const { AgentMemory } = await import("../memory/index.js");
      const { dbPath, findRepoRoot } = await import("../config/index.js");
      const { SqliteStore } = await import("../store/sqlite.js");

      const root = opts.root ?? process.cwd();
      const wardenRoot = findRepoRoot(root);
      const store = await SqliteStore.open(dbPath(wardenRoot));
      const memory = new AgentMemory(store);

      try {
        const result = await sufficientContext({
          task,
          repoRoot: root,
          maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : 15,
          tokenBudget: opts.budget ? parseInt(opts.budget, 10) : undefined,
          store,
          memory: {
            recall: (q, n) => memory.recall(q, n),
            findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
          },
          git: {
            gitChangeFrequency: (r, p) => gitChangeFrequency(r, p),
          },
          memoryLimit: opts.memoryLimit ? parseInt(opts.memoryLimit, 10) : 5,
          failedApproachLimit: opts.failedLimit ? parseInt(opts.failedLimit, 10) : 3,
        });

        process.stdout.write(formatSufficientContext(result) + "\n");
      } finally {
        store.close();
      }
    });

  // ---- outcome tracking command ----
  program
    .command("outcomes")
    .description(
      "Show task outcome statistics — success rates with/without pruning",
    )
    .action(async () => {
      const warden = await Warden.create();
      try {
        process.stdout.write(chalk.bold("\n  Warden task outcomes\n"));
        process.stdout.write(
          chalk.gray(
            "  ─────────────────────────────────────────────────────────\n",
          ),
        );
        process.stdout.write(`  ${warden.tracker.summary()}\n\n`);
      } finally {
        warden.close();
      }
    });

  // ---- Code intelligence commands ----

  program
    .command("index")
    .description(
      "Index the current project's code structure — functions, classes, imports, call sites. Run before warden graph/impact/architecture.",
    )
    .option("-f, --force", "Force full re-index (ignore cached mtimes)")
    .option("-m, --max-files <n>", "Maximum files to index", "10000")
    .action(async (opts: { force?: boolean; maxFiles?: string }) => {
      const { CodeIndex } = await import("../index/indexer.js");
      const warden = await Warden.create();
      try {
        const repoRoot = warden.repoRoot ?? process.cwd();
        const indexer = new CodeIndex(warden.store);
        const result = await indexer.index({
          repoRoot,
          force: opts.force,
          maxFiles: parseInt(opts.maxFiles ?? "10000", 10),
        });
        process.stdout.write(
          chalk.bold.cyan(
            `\nwarden index — ${result.filesParsed}/${result.filesScanned} files parsed in ${result.durationMs}ms\n`,
          ) +
            chalk.gray(
              `  symbols: ${result.symbolsFound}  imports: ${result.importsFound}  calls: ${result.callsFound}\n`,
            ) +
            (result.skipped.length > 0
              ? chalk.gray(`  skipped: ${result.skipped.length} files\n`)
              : "") +
            chalk.gray(
              `\n  Now use: warden graph <function>, warden impact <file>, warden architecture\n\n`,
            ),
        );
      } finally {
        warden.close();
      }
    });

  program
    .command("graph")
    .description(
      "Query the call graph: who calls a function, or what it calls.",
    )
    .argument("<function>", "Function name to query")
    .option(
      "-d, --direction <dir>",
      "callers, callees, or both (default: both)",
    )
    .action(async (funcName: string, opts: { direction?: string }) => {
      const { GraphQuery } = await import("../index/graph.js");
      const warden = await Warden.create();
      try {
        const repoRoot = warden.repoRoot ?? process.cwd();
        const graph = new GraphQuery(warden.store, repoRoot);
        const dir = opts.direction ?? "both";

        process.stdout.write(
          chalk.bold.cyan(`\nwarden graph — ${funcName} (${dir})\n\n`),
        );

        if (dir === "callers" || dir === "both") {
          const callers = graph.callers(funcName);
          process.stdout.write(chalk.bold(`Callers (${callers.length}):\n`));
          if (callers.length === 0) {
            process.stdout.write(chalk.gray("  (none found)\n"));
          } else {
            for (const c of callers) {
              process.stdout.write(
                `  ${c.filePath}:${c.line}  ${c.callerName}() → ${c.calleeName}()\n`,
              );
            }
          }
          process.stdout.write("\n");
        }

        if (dir === "callees" || dir === "both") {
          const callees = graph.callees(funcName);
          process.stdout.write(chalk.bold(`Callees (${callees.length}):\n`));
          if (callees.length === 0) {
            process.stdout.write(chalk.gray("  (none found)\n"));
          } else {
            for (const c of callees) {
              process.stdout.write(
                `  ${c.filePath}:${c.line}  ${c.callerName}() → ${c.calleeName}()\n`,
              );
            }
          }
        }
        process.stdout.write("\n");
      } finally {
        warden.close();
      }
    });

  program
    .command("impact")
    .description("Impact analysis: what's affected by changes to a file?")
    .argument("<file>", "Path to the changed file")
    .action(async (filePath: string) => {
      const { GraphQuery } = await import("../index/graph.js");
      const warden = await Warden.create();
      try {
        const repoRoot = warden.repoRoot ?? process.cwd();
        const graph = new GraphQuery(warden.store, repoRoot);
        const result = graph.impact(filePath);

        process.stdout.write(
          chalk.bold.cyan(`\nwarden impact — ${filePath}\n`) +
            chalk.bold(`  Risk: ${result.risk.toUpperCase()}\n\n`),
        );

        process.stdout.write(
          chalk.bold(
            `Direct dependents (${result.directDependents.length}):\n`,
          ),
        );
        for (const f of result.directDependents.slice(0, 15)) {
          process.stdout.write(`  ${f}\n`);
        }
        if (result.directDependents.length > 15) {
          process.stdout.write(
            chalk.gray(`  … and ${result.directDependents.length - 15} more\n`),
          );
        }

        process.stdout.write(
          chalk.bold(
            `\nAffected symbols (${result.affectedSymbols.length}):\n`,
          ),
        );
        for (const s of result.affectedSymbols.slice(0, 15)) {
          process.stdout.write(
            `  ${s.kind} ${s.name} (${s.filePath}:${s.startLine})\n`,
          );
        }

        process.stdout.write(
          chalk.bold(
            `\nAffected callers (${result.affectedCallers.length}):\n`,
          ),
        );
        for (const c of result.affectedCallers.slice(0, 15)) {
          process.stdout.write(
            `  ${c.filePath}:${c.line}  ${c.callerName}() → ${c.calleeName}()\n`,
          );
        }
        process.stdout.write("\n");
      } finally {
        warden.close();
      }
    });

  program
    .command("architecture")
    .description(
      "Project architecture overview: languages, packages, entry points, hotspots.",
    )
    .action(async () => {
      const { GraphQuery } = await import("../index/graph.js");
      const warden = await Warden.create();
      try {
        const repoRoot = warden.repoRoot ?? process.cwd();
        const graph = new GraphQuery(warden.store, repoRoot);
        const arch = graph.architecture();

        process.stdout.write(
          chalk.bold.cyan(
            `\nwarden architecture — ${arch.totalFiles} files, ${arch.totalSymbols} symbols, ${arch.totalCalls} calls\n\n`,
          ),
        );

        process.stdout.write(chalk.bold("Languages:\n"));
        for (const l of arch.languages) {
          process.stdout.write(`  ${l.language}: ${l.fileCount} files\n`);
        }

        process.stdout.write(chalk.bold("\nPackages:\n"));
        for (const p of arch.packages) {
          process.stdout.write(
            `  ${p.name.padEnd(20)} ${p.fileCount} files, ${p.symbolCount} symbols\n`,
          );
        }

        process.stdout.write(
          chalk.bold(`\nEntry points (${arch.entryPoints.length}):\n`),
        );
        for (const s of arch.entryPoints.slice(0, 20)) {
          process.stdout.write(
            `  ${s.kind} ${s.name} (${s.filePath}:${s.startLine})${s.async ? " async" : ""}\n`,
          );
        }

        process.stdout.write(chalk.bold("\nHotspots:\n"));
        for (const h of arch.hotspots) {
          process.stdout.write(
            `  ${h.filePath.padEnd(40)} ${h.symbolCount} symbols, ${h.callerCount} callers\n`,
          );
        }
        process.stdout.write("\n");
      } finally {
        warden.close();
      }
    });

  // ---- CCR (reversible pruning) ----

  const ccrCmd = program
    .command("ccr")
    .description("Manage CCR (reversible pruning) cache — stored originals.")
    .action(async () => {
      const warden = await Warden.create();
      try {
        const summary = ccrSummary(warden.store);
        process.stdout.write(
          chalk.bold.cyan(
            `\nwarden ccr — ${summary.count} originals cached, ${summary.tokensSaved} tokens retrievable\n`,
          ),
        );
        process.stdout.write(
          chalk.gray(`  TTL: 7 days\n  Commands: \`warden ccr retrieve <hash>\`, \`warden ccr cleanup\`\n\n`),
        );
      } finally {
        warden.close();
      }
    });

  ccrCmd
    .command("retrieve <hash>")
    .description(
      "Retrieve an original output by hash. Use --around <string> for slice around a match, or --lines <start:end> for explicit range.",
    )
    .option("-a, --around <string>", "Return lines around the first match of this string")
    .option("-l, --lines <range>", 'Line range, e.g. "120:170" (1-based, inclusive)')
    .option("-c, --context <n>", "Lines of context around --around match (default: 10)", "10")
    .action(async (hash: string, opts: { around?: string; lines?: string; context?: string }) => {
      const warden = await Warden.create();
      try {
        let lineRange: [number, number] | undefined;
        if (opts.lines) {
          const parts = opts.lines.split(":");
          if (parts.length === 2) {
            const s = parseInt(parts[0]!, 10);
            const e = parseInt(parts[1]!, 10);
            if (!isNaN(s) && !isNaN(e)) lineRange = [s, e];
          }
        }

        const { retrieveSlice } = await import("../ccr/index.js");
        const result = retrieveSlice(warden.store, hash, {
          around: opts.around,
          lines: lineRange,
          context: opts.context ? parseInt(opts.context, 10) : undefined,
        });
        if (!result) {
          process.stderr.write(
            chalk.red(`CCR miss — no original found for hash "${hash}"\n`),
          );
          process.exit(1);
        }
        process.stdout.write(result.output + "\n");
      } finally {
        warden.close();
      }
    });

  ccrCmd
    .command("cleanup")
    .description("Remove CCR entries older than the TTL (default 7 days).")
    .option("-d, --days <n>", "Max age in days (default: 7)", "7")
    .action(async (opts) => {
      const warden = await Warden.create();
      try {
        const days = parseInt(opts.days, 10) || 7;
        const removed = ccrCleanup(warden.store, days);
        process.stdout.write(
          chalk.bold.cyan(
            `\nwarden ccr cleanup — removed ${removed} entries older than ${days} days\n\n`,
          ),
        );
      } finally {
        warden.close();
      }
    });

  // ---- benchmark command ----

  program
    .command("benchmark")
    .description("Run actual benchmarks on real files — pruning, compression, response rules.")
    .action(async () => {
      const { runBenchmark } = await import("./benchmark.js");
      await runBenchmark();
    });

  // ---- handoff command ----

  program
    .command("handoff")
    .description(
      "Session handoff — generate a compact summary for the next session, or read the last one. Use --read at session start, use --generate (default) at session end or before compaction.",
    )
    .option("-h, --hours <n>", "Lookback window in hours (default: 8, or since last handoff)", "8")
    .option("--read", "Read the last handoff document (use at session start)", false)
    .option("--generate", "Generate a new handoff document (use at session end)", true)
    .action(async (opts: { hours: string; read: boolean; generate: boolean }) => {
      const warden = await Warden.create();
      try {
        const { HandoffGenerator } = await import("../handoff/index.js");
        const gen = new HandoffGenerator(warden.store);

        if (opts.read) {
          const last = gen.readLast();
          if (!last) {
            process.stdout.write(
              "No previous handoff found. Run `warden handoff` (without --read) at session end to generate one.\n",
            );
          } else {
            process.stdout.write(last.document + "\n");
            process.stderr.write(
              chalk.gray(`\nLast handoff: ${last.timestamp.slice(0, 19).replace("T", " ")}\n`),
            );
          }
          return;
        }

        const hours = parseInt(opts.hours, 10) || 8;
        const result = gen.generate(hours);
        process.stdout.write(result.document + "\n");
        process.stderr.write(
          chalk.gray(
            `\nHandoff generated: ${result.counts.memories} memories, ${result.counts.outcomes} outcomes, ${result.counts.filesTouched} files, ${result.counts.decisions} decisions\n`,
          ),
        );
      } finally {
        warden.close();
      }
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    logger.error("cli error", { err: String(err) });
    fail(String(err));
  }
}

// Run when invoked directly (not imported).
// Use pathToFileURL to normalize the argv path, then compare against
// import.meta.url. This handles Windows backslashes, forward slashes,
// and any quoting artifacts in the path.
const invoked = (() => {
  try {
    if (!process.argv[1]) return false;
    // Strip any surrounding quotes that may have been passed through
    // from a broken MCP config (e.g. "\"C:\\path\\cli.js\"" → "C:\path\cli.js").
    const argvPath = process.argv[1].replace(/^"(.*)"$/, "$1");
    const argvUrl = pathToFileURL(resolve(argvPath)).href;
    return import.meta.url === argvUrl;
  } catch {
    // Fall back to the old endsWith check if pathToFileURL fails
    try {
      return (
        process.argv[1] &&
        import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
      );
    } catch {
      return false;
    }
  }
})();
if (invoked) {
  runCli().catch((err) => {
    logger.error("fatal", { err: String(err) });
    process.exit(1);
  });
}

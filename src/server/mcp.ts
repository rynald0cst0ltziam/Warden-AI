/**
 * Warden MCP server.
 *
 * Two kinds of tools:
 *
 * 1. Wrapper tools (automatic pruning — the agent calls these instead of its
 *    built-in tools and gets pruned output in one shot):
 *    warden_grep         — search files, return pruned results
 *    warden_file_read    — read a file, return pruned content
 *    warden_run_tests    — run a test command, return pruned output
 *    warden_run_command  — run any shell command, return pruned output
 *
 * 2. Manual tools (for pruning output from tools Warden doesn't wrap):
 *    warden_prune   — prune a tool output for the current task
 *    warden_status  — active/shadow rules + confidence + tokens saved
 *    warden_report  — what the last prune cut and why (transparency)
 *
 * All logging goes to stderr; stdout is reserved for the JSON-RPC protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Warden } from "../warden.js";
import type { ToolType } from "../pruner/types.js";
import { logger } from "../logging/index.js";
import { selectContext, type CodeIndexStore } from "../context/index.js";
import { AgentMemory } from "../memory/index.js";
import { TaskTracker } from "../eval/outcomes.js";
import { compressFile } from "../compress/index.js";
import { CodeIndex } from "../index/indexer.js";
import { GraphQuery } from "../index/graph.js";
import {
  wardenGrep,
  wardenFileRead,
  wardenRunTests,
  wardenRunCommand,
} from "./tools.js";
import {
  retrieveOriginal,
  retrieveSlice,
  ccrSummary,
  ccrCleanup,
  extractCcrMarker,
} from "../ccr/index.js";
import {
  buildWardenMeta,
  formatWardenAnnotation,
  formatWardenBadge,
  formatWardenCumulative,
  formatWardenCcr,
  formatWardenMetaJson,
} from "../pruner/types.js";
import { compressDescription } from "../output/compress-descriptions.js";
import { findRepoRoot, ensureWardenDir, dbPath } from "../config/index.js";
import { writeRules } from "../cli/rules.js";
import { buildTaskReport, formatTaskReport } from "../measurement/report.js";
import { gitContext, formatGitContext, gitChangeFrequency } from "../git/context.js";
import { sufficientContext, formatSufficientContext } from "../context/sufficient.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SqliteStore } from "../store/sqlite.js";

const TOOL_TYPES: ToolType[] = [
  "grep",
  "search",
  "file-read",
  "test-log",
  "web-fetch",
  "json",
  "generic",
];

export interface CreateMcpOptions {
  warden?: Warden;
}

export async function createMcpServer(opts: CreateMcpOptions = {}): Promise<{
  server: McpServer;
  warden: Warden;
}> {
  const warden = opts.warden ?? (await Warden.create());
  const server = new McpServer({
    name: "Warden",
    version: "0.1.0",
  });

  // Create memory and tracker early — they're used by warden_status (auto-surface
  // memories) and warden_record_outcome (auto-save failures) in addition to the
  // explicit memory/outcome tools.
  const memory = new AgentMemory(warden.store);
  const tracker = new TaskTracker(warden.store);

  // ---- Per-project store cache ----
  // The MCP server is a single long-running process whose cwd is fixed at
  // startup. When the agent switches projects, the server would still use the
  // original project's DB. To fix this, memory/handoff/outcome tools accept a
  // `repoRoot` parameter. When provided, we open (or reuse) a separate
  // SqliteStore for that project, ensuring memories are isolated per project.
  interface ProjectStore {
    store: typeof warden.store;
    memory: AgentMemory;
    tracker: TaskTracker;
  }
  const projectStores = new Map<string, ProjectStore>();
  const defaultRepoRoot = warden.repoRoot ?? process.cwd();

  async function getProjectStore(repoRoot?: string): Promise<ProjectStore> {
    const resolved = resolve(repoRoot ?? defaultRepoRoot);
    if (resolved === resolve(defaultRepoRoot)) {
      return { store: warden.store, memory, tracker };
    }
    let cached = projectStores.get(resolved);
    if (!cached) {
      const path = dbPath(resolved);
      ensureWardenDir(resolved);
      const { SqliteStore } = await import("../store/sqlite.js");
      const store = await SqliteStore.open(path);
      cached = {
        store,
        memory: new AgentMemory(store),
        tracker: new TaskTracker(store),
      };
      projectStores.set(resolved, cached);
    }
    return cached;
  }

  // Code index adapter for 2-hop symbol expansion in context selection.
  // Wraps the raw SQLite store to satisfy the CodeIndexStore interface.
  const codeIndexAdapter: CodeIndexStore = {
    hasIndex(repoRoot: string): boolean {
      try {
        const row = warden.store.db
          .prepare("SELECT COUNT(*) AS n FROM index_files WHERE project = ?")
          .get(repoRoot) as { n: number } | undefined;
        return (row?.n ?? 0) > 0;
      } catch {
        return false;
      }
    },
    getImportsForFile(filePath: string, repoRoot: string): string[] {
      try {
        const rows = warden.store.db
          .prepare(
            "SELECT resolved_path FROM index_imports WHERE project = ? AND file_path = ? AND resolved_path IS NOT NULL",
          )
          .all(repoRoot, filePath) as { resolved_path: string }[];
        return rows
          .map((r) => r.resolved_path)
          .filter((p): p is string => !!p);
      } catch {
        return [];
      }
    },
    getSymbolsForFile(
      filePath: string,
      repoRoot: string,
    ): Array<{ name: string; kind: string; params: string[]; exported: boolean }> {
      try {
        const rows = warden.store.db
          .prepare(
            "SELECT name, kind, params_json, exported FROM index_symbols WHERE project = ? AND file_path = ?",
          )
          .all(repoRoot, filePath) as {
          name: string;
          kind: string;
          params_json: string;
          exported: number;
        }[];
        return rows.map((r) => ({
          name: r.name,
          kind: r.kind,
          params: JSON.parse(r.params_json ?? "[]") as string[],
          exported: !!r.exported,
        }));
      } catch {
        return [];
      }
    },
  };

  // Helper: compress a tool description to save input tokens (descriptions sit
  // in context for the entire session). Equivalent of caveman-shrink, applied
  // to our own tool descriptions.
  const cd = (desc: string): string => compressDescription(desc);

  // Shared response for code-intelligence tools when the project hasn't been
  // indexed yet. Guides the agent to run warden_index instead of returning
  // confusing empty results.
  const emptyIndexResponse = () => ({
    content: [
      {
        type: "text" as const,
        text: "No code index found for this project yet. Run warden_index first (or `warden index` in a terminal) to build the code intelligence database, then retry.",
      },
    ],
  });

  const PruneShape = {
    toolType: z
      .enum(TOOL_TYPES as [ToolType, ...ToolType[]])
      .describe("The kind of tool output being pruned."),
    rawOutput: z.string().describe("The raw tool output to prune."),
    userMessage: z
      .string()
      .optional()
      .describe(
        "The user message for the current turn, used to classify the task.",
      ),
    taskHint: z
      .string()
      .optional()
      .describe(
        "Optional free-text relevance hint, e.g. 'debugging null-pointer in auth.py'.",
      ),
    toolName: z
      .string()
      .optional()
      .describe("The tool that produced the output, if known."),
  };

  server.tool(
    "warden_prune",
    cd("Prune tool output to what the task needs. Removes irrelevant content only — never rewrites code, commands, or errors. Returns pruned output + cut summary + rule confidence."),
    PruneShape,
    async (args) => {
      const res = await warden.pruneCall({
        toolType: args.toolType,
        rawOutput: args.rawOutput,
        userMessage: args.userMessage,
        taskHint: args.taskHint,
        toolName: args.toolName ?? null,
      });
      // Extract CCR hash from the shipped output if a marker was appended.
      const ccrHash = extractCcrMarker(res.shipped);
      const meta = buildWardenMeta({
        result: res.result,
        stage: res.stage,
        applied: res.applied,
        ccrHash,
      });
      // Badge at TOP — visible first, even in collapsed tool output
      const top: string[] = [
        formatWardenBadge(meta),
        `‹warden› ${res.result.removed.summary}`,
      ];
      if (ccrHash) {
        top.push(formatWardenCcr(ccrHash));
      }
      const text = [
        ...top,
        "",
        res.shipped,
        "",
        formatWardenAnnotation(meta),
        formatWardenMetaJson(meta),
      ];
      return {
        content: [{ type: "text", text: text.join("\n") }],
      };
    },
  );

  // ---- CCR: reversible pruning ----

  server.tool(
    "warden_retrieve",
    cd("Retrieve the original output that was pruned. Supports slice-based retrieval: pass `around` to get lines around a search string, or `lines` for an explicit range. Without slice options, returns the full original. The hash is in the ‹warden› marker at the end of pruned output."),
    {
      hash: z
        .string()
        .describe("The 12-char hash from the ‹warden› retrieve marker."),
      around: z
        .string()
        .optional()
        .describe(
          "Search string — returns lines around the first match (default 10 lines of context each side).",
        ),
      lines: z
        .string()
        .optional()
        .describe(
          'Explicit line range, e.g. "120:170" (1-based, inclusive). Overrides `around`.',
        ),
      context: z
        .number()
        .optional()
        .describe(
          "Lines of context above/below the `around` match (default: 10).",
        ),
    },
    async (args) => {
      // Parse lines param "120:170" → [120, 170]
      let lineRange: [number, number] | undefined;
      if (args.lines) {
        const parts = args.lines.split(":");
        if (parts.length === 2) {
          const s = parseInt(parts[0]!, 10);
          const e = parseInt(parts[1]!, 10);
          if (!isNaN(s) && !isNaN(e)) lineRange = [s, e];
        }
      }

      const result = retrieveSlice(warden.store, args.hash, {
        around: args.around,
        lines: lineRange,
        context: args.context,
      });
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: `CCR miss — no original found for hash "${args.hash}". It may have expired (TTL is 7 days) or was never stored.`,
            },
          ],
        };
      }

      if (result.isSlice && result.sliceRange) {
        const r = result.sliceRange;
        const header = [
          `‹warden› retrieved slice (hash=${args.hash}, toolType=${result.toolType})`,
          `  lines ${r.start}-${r.end} of ${r.totalLines} | full tokens: ${result.tokensFull}`,
          `  full output: warden_retrieve("${args.hash}")`,
          "",
        ];
        return { content: [{ type: "text", text: header.join("\n") + result.output }] };
      }

      const lines = [
        `‹warden› retrieved original output (hash=${args.hash}, toolType=${result.toolType})`,
        `  tokens: ${result.tokensFull}`,
        "",
        result.output,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_ccr_status",
    cd("Show CCR (reversible pruning) state: how many originals cached, tokens saved, cleanup info."),
    {},
    async () => {
      const summary = ccrSummary(warden.store);
      const lines = [
        `Warden CCR — ${summary.count} originals cached, ${summary.tokensSaved} tokens retrievable`,
        `  TTL: 7 days (run \`warden ccr cleanup\` to force-expire)`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ---- Wrapper tools (automatic pruning) ----

  server.tool(
    "warden_grep",
    cd("Search files, return pruned results. Use instead of built-in grep — searches AND prunes in one call. Respects .gitignore via ripgrep."),
    {
      pattern: z.string().describe("The regex pattern to search for."),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to search in (default: current working directory).",
        ),
      glob: z
        .string()
        .optional()
        .describe("File glob filter, e.g. '*.ts' or '**/*.{js,ts}'."),
      ignoreCase: z.boolean().optional().describe("Case-insensitive search."),
      maxResults: z
        .number()
        .optional()
        .describe("Maximum matches to return before pruning (default: 500)."),
    },
    async (args) => {
      const output = await wardenGrep(warden, args);
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "warden_file_read",
    cd("Read file, return pruned content. Large files get relevant slice + outline of rest. Use instead of built-in file-read. Code never rewritten, only included/excluded."),
    {
      filePath: z
        .string()
        .describe("Path to the file to read (absolute or relative to cwd)."),
      startLine: z
        .number()
        .optional()
        .describe("Start reading from this line (1-based)."),
      endLine: z
        .number()
        .optional()
        .describe("Stop reading at this line (1-based)."),
    },
    async (args) => {
      const output = await wardenFileRead(warden, args);
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "warden_run_tests",
    cd("Run tests, return pruned output. Keeps failures + context, collapses passing noise. Use instead of running tests directly. Errors/stack traces never rewritten."),
    {
      command: z
        .string()
        .optional()
        .describe("Test command to run (default: 'npm test')."),
      cwd: z.string().optional().describe("Working directory for the command."),
    },
    async (args) => {
      const output = await wardenRunTests(warden, args);
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "warden_run_command",
    cd("Run shell command, return pruned output. Strips low-signal lines, keeps errors + relevant content. Use instead of running commands directly."),
    {
      command: z.string().describe("The shell command to run."),
      cwd: z.string().optional().describe("Working directory for the command."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default: 60000)."),
    },
    async (args) => {
      const output = await wardenRunCommand(warden, args);
      return { content: [{ type: "text", text: output }] };
    },
  );

  // ---- Manual / status tools ----

  server.tool(
    "warden_status",
    cd("Show Warden state: rules, stages, confidence, tokens saved, AND recent project memories. Call at session start to see savings + surface past decisions automatically."),
    {
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const status = warden.status();
      const totalSaved = warden.totalTokensSaved();
      const totalProcessed = warden.totalTokensProcessed();
      const reductionPct =
        totalProcessed > 0
          ? Math.round((totalSaved / totalProcessed) * 100)
          : 0;
      const activeRules = status.filter((s) => s.stage === "active").length;
      const totalCalls = status.reduce((sum, s) => sum + s.calls, 0);

      const lines = [
        `Warden — ${activeRules}/${status.length} rules active | ${totalSaved} tokens saved (${reductionPct}% reduction) | ${totalProcessed} processed`,
        "",
        ...status.map((s) => {
          const pct =
            s.tokensFull > 0
              ? Math.round((s.tokensSaved / s.tokensFull) * 100)
              : 0;
          return `  ${s.ruleId.padEnd(36)} ${s.stage.padEnd(8)} conf=${s.confidence.toFixed(2)} saved=${s.tokensSaved} (${pct}%) calls=${s.calls}${s.decaying ? " ⚠decaying" : ""}`;
        }),
      ];

      // Compliance warning: if no pruning calls have been made, the agent
      // is likely using built-in tools instead of Warden wrappers.
      if (totalCalls === 0) {
        lines.push(
          "",
          "⚠ COMPLIANCE WARNING: 0 pruning calls recorded. You appear to be using built-in",
          "  read/grep tools instead of Warden wrappers. Use warden_file_read and warden_grep",
          "  to get automatic 50-90% token reduction on every tool call. If hooks are",
          "  installed (warden init), Read/Grep calls should be auto-redirected.",
        );
      }

      // Auto-inject recent memories so the agent sees them at session start
      // without needing a separate warden_memory_recall call.
      // Use project-scoped memory if repoRoot is provided.
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const recentMemories = projectMemory.list(5);
      if (recentMemories.length > 0) {
        lines.push("", "Recent project memories (auto-surfaced):");
        for (const m of recentMemories) {
          lines.push(
            `  [${m.category}] ${m.title} (${m.timestamp.slice(0, 10)}, accessed ${m.accessCount}x)`,
          );
        }
        lines.push("  Use warden_memory_recall({ query: '...' }) for more specific memories.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_report",
    cd("Recent pruning decisions from audit trail: what was cut, when, confidence at time."),
    {
      limit: z
        .number()
        .optional()
        .describe("Number of recent decisions to return (default 10)."),
    },
    async (args) => {
      const decisions = warden.store.recentDecisions(args.limit ?? 10);
      const lines = decisions.map((d) => {
        let detail: Record<string, unknown>;
        try {
          detail = JSON.parse(d.detail_json) as Record<string, unknown>;
        } catch {
          detail = { detail: d.detail_json };
        }
        return `[${d.timestamp}] ${d.kind} rule=${d.rule_id ?? "-"} tokens_saved=${d.tokens_saved} ${JSON.stringify(detail)}`;
      });
      return {
        content: [
          {
            type: "text",
            text: lines.length
              ? lines.join("\n")
              : "No decisions recorded yet.",
          },
        ],
      };
    },
  );

  // ---- P0a: Task performance report ----
  server.tool(
    "warden_task_report",
    cd("Show a task performance report: tokens saved, reduction %, guard results, task outcomes. Pass --all for project-wide historical report, or time range with since/until. Call after completing tasks to see Warden's measured impact."),
    {
      since: z
        .string()
        .optional()
        .describe("Start time (ISO 8601). Defaults to 24h ago."),
      until: z
        .string()
        .optional()
        .describe("End time (ISO 8601). Defaults to now."),
      task: z
        .string()
        .optional()
        .describe("Filter outcomes by task description (substring match)."),
      all: z
        .boolean()
        .optional()
        .describe("Show project-wide historical report instead of time range."),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectStore = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).store
        : warden.store;

      if (args.all) {
        // Project-wide historical report
        const totalSaved = projectStore.totalTokensSaved();
        const totalProcessed = projectStore.totalTokensProcessed();
        const reductionPct =
          totalProcessed > 0
            ? Math.round((totalSaved / totalProcessed) * 1000) / 10
            : 0;
        const outcomes = projectStore.recentTaskOutcomes(20);
        const totalTasks = outcomes.length;
        const successful = outcomes.filter((o) => o.success === 1).length;
        const ccrCount = projectStore.ccrCount();
        const ccrTokens = projectStore.ccrTokensSaved();

        const lines = [
          "WARDEN PROJECT REPORT — ALL TIME",
          "────────────────────────────────────────",
          "",
          `Tokens saved (gross):  ${totalSaved.toLocaleString()}`,
          `Tokens processed:      ${totalProcessed.toLocaleString()}`,
          `Reduction:             ${reductionPct}%`,
          "",
          `Tasks tracked:         ${totalTasks}`,
          `Successful:            ${successful}`,
          `Success rate:          ${totalTasks > 0 ? ((successful / totalTasks) * 100).toFixed(1) : "0"}%`,
          "",
          `CCR cached originals:  ${ccrCount}`,
          `CCR tokens retrievable: ${ccrTokens.toLocaleString()}`,
        ];
        if (outcomes.length > 0) {
          lines.push("", "RECENT TASK OUTCOMES");
          for (const o of outcomes) {
            const status = o.success === 1 ? "SUCCESS" : "FAILURE";
            const pruned = o.pruned === 1 ? "pruned" : "raw";
            lines.push(
              `  [${status}] ${o.task} (${pruned}, saved=${o.tokens_saved})`,
            );
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const end = args.until ?? new Date().toISOString();
      const start =
        args.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const report = buildTaskReport(projectStore, {
        start,
        end,
        taskFilter: args.task,
      });

      return {
        content: [{ type: "text", text: formatTaskReport(report) }],
      };
    },
  );

  // ---- Layer 1: Input context selection ----
  server.tool(
    "warden_context_select",
    cd("Scan project, extract relevant code/sections for task. Use BEFORE starting work. Returns snippets + outlines, not full files."),
    {
      task: z
        .string()
        .describe(
          "The task you're about to work on (e.g., 'fix null pointer in auth.ts')",
        ),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      maxFiles: z
        .number()
        .optional()
        .describe("Maximum files to recommend (default 15)"),
    },
    async (args) => {
      const result = await selectContext({
        task: args.task,
        repoRoot: args.repoRoot ?? process.cwd(),
        maxFiles: args.maxFiles,
        store: warden.store,
        codeIndex: codeIndexAdapter,
      });
      // Build the compact context package — actual code snippets + outlines.
      const lines = [
        `Warden context selection — ${result.package.length} files, ${result.reductionPct}% smaller than reading full files`,
        `  full: ~${result.tokensFull} tokens → compact: ~${result.tokensCompact} tokens`,
        "",
        result.reasoning,
        "",
      ];

      for (const file of result.package) {
        const relPath = file.filePath;
        // Dependency signature files have totalLines=0 and no slices
        const isDep = file.totalLines === 0 && file.slices.length === 0;
        if (isDep) {
          lines.push(
            `── ${relPath} (dependency signatures — ${file.reason}) ──`,
          );
          for (const ol of file.outline) {
            lines.push(`    ${ol.header}`);
          }
          lines.push("");
          continue;
        }
        lines.push(
          `── ${relPath} (${file.totalLines} lines, showing ${file.linesIncluded}) ──`,
        );
        for (const slice of file.slices) {
          lines.push(
            `  [lines ${slice.startLine}-${slice.endLine}] ${slice.reason}:`,
          );
          for (const codeLine of slice.code.split("\n")) {
            lines.push(`  ${codeLine}`);
          }
        }
        if (file.outline.length > 0) {
          lines.push(
            `  … outline (${file.outline.length} more blocks not shown):`,
          );
          for (const ol of file.outline) {
            lines.push(`    L${ol.line}: ${ol.header}`);
          }
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ---- P4: Unified sufficient context ----
  server.tool(
    "warden_sufficient_context",
    cd("Get unified minimal sufficient context for a task — file recommendations + past decisions + failed approach warnings + git volatility. Use INSTEAD OF warden_context_select when you want the full picture. Combines all Warden layers into one response."),
    {
      task: z
        .string()
        .describe("The task you're about to work on"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      maxFiles: z
        .number()
        .optional()
        .describe("Maximum files to recommend (default 15)"),
      tokenBudget: z
        .number()
        .optional()
        .describe("Optional token budget — trims package to fit"),
      memoryLimit: z
        .number()
        .optional()
        .describe("Max past decisions to recall (default 5)"),
      failedApproachLimit: z
        .number()
        .optional()
        .describe("Max failed approaches to surface (default 3)"),
    },
    async (args) => {
      const memory = warden.memory;
      const result = await sufficientContext({
        task: args.task,
        repoRoot: args.repoRoot ?? process.cwd(),
        maxFiles: args.maxFiles,
        tokenBudget: args.tokenBudget,
        store: warden.store,
        codeIndex: codeIndexAdapter,
        memory: memory
          ? {
              recall: (q, n) => memory.recall(q, n),
              findFailedApproaches: (q, n) => memory.findFailedApproaches(q, n),
            }
          : undefined,
        git: {
          gitChangeFrequency: (root, path) => gitChangeFrequency(root, path),
        },
        memoryLimit: args.memoryLimit,
        failedApproachLimit: args.failedApproachLimit,
      });
      return {
        content: [{ type: "text", text: formatSufficientContext(result) }],
      };
    },
  );

  // ---- P3: Git context ----
  server.tool(
    "warden_git_context",
    cd("Get git history, blame, and change frequency for a file. Use to understand why code looks the way it does — recent commits, churn metrics, line-level blame. Helps decide if code is stable or volatile."),
    {
      filePath: z
        .string()
        .describe("Path to the file (relative to repoRoot or absolute)."),
      startLine: z
        .number()
        .optional()
        .describe("Start line for blame (1-based, inclusive)."),
      endLine: z
        .number()
        .optional()
        .describe("End line for blame (1-based, inclusive)."),
      includeBlame: z
        .boolean()
        .optional()
        .describe("Include line-level blame (slower — default false)."),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory (defaults to server cwd)."),
    },
    async (args) => {
      const root = args.repoRoot ?? process.cwd();
      const ctx = gitContext(root, args.filePath, {
        startLine: args.startLine,
        endLine: args.endLine,
        includeBlame: args.includeBlame,
      });
      return {
        content: [{ type: "text", text: formatGitContext(ctx) }],
      };
    },
  );

  // ---- Layer 3: Agent memory ----

  server.tool(
    "warden_memory_save",
    cd("Save durable project decision/finding/pattern. Use AFTER important decisions. Only things that persist across sessions. Supports structured provenance (sourceType, evidence), scope, outcome for failed approaches, and supersedesId for decision lifecycle."),
    {
      category: z
        .enum(["decision", "finding", "pattern", "constraint", "preference", "failed_approach"])
        .describe("Type of memory. Use 'failed_approach' for approaches that didn't work."),
      title: z
        .string()
        .describe("Short summary (e.g., 'Use Stripe for payments')"),
      body: z.string().describe("Detailed explanation of the decision/finding"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for later retrieval (e.g., ['payments', 'billing'])"),
      source: z
        .string()
        .optional()
        .describe("What triggered this (e.g., 'user request')"),
      sourceType: z
        .string()
        .optional()
        .describe("Type of source: 'human' | 'agent' | 'documentation' | 'commit' | 'configuration' | 'code' | 'test' | 'explicit_user_instruction'"),
      evidence: z
        .array(z.string())
        .optional()
        .describe("Evidence references (file paths, commit SHAs, URLs) supporting this decision"),
      scope: z
        .string()
        .optional()
        .describe("Scope of the decision (file path, module, or omit for global)"),
      outcome: z
        .string()
        .optional()
        .describe("Outcome: 'success' or 'failure'. Use 'failure' with category 'failed_approach' to record approaches that didn't work."),
      supersedesId: z
        .number()
        .optional()
        .describe("ID of the decision this one supersedes. The old decision will be marked as superseded."),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      // Check for conflicts BEFORE saving (so we can report them)
      const conflicts = projectMemory.findConflicts(args.title, args.category);
      const id = projectMemory.save({
        category: args.category,
        title: args.title,
        body: args.body,
        tags: args.tags ?? [],
        source: args.source,
        sourceType: args.sourceType,
        evidence: args.evidence,
        scope: args.scope,
        outcome: args.outcome,
        supersedesId: args.supersedesId,
      });
      // Check if this was a dedup (existing id returned)
      const all = projectMemory.list(1000);
      const isDedup = all.some((m) => m.id === id && m.title !== args.title);

      const lines = [`Memory saved (id=${id}): [${args.category}] ${args.title}`];

      if (isDedup) {
        lines.push(
          `Note: A memory with this title already existed. Returned existing id=${id}.`,
        );
      }

      if (args.supersedesId) {
        lines.push(`Superseded decision id=${args.supersedesId} (marked as superseded).`);
      }

      // Report conflicts (excluding the one we just saved)
      const realConflicts = conflicts.filter((c) => c.id !== id);
      if (realConflicts.length > 0) {
        lines.push(
          `WARNING: ${realConflicts.length} potential conflict(s) detected in category "${args.category}":`,
        );
        for (const c of realConflicts) {
          lines.push(`  - [${c.category}] ${c.title} (id=${c.id})`);
        }
        lines.push(
          "If the new memory supersedes an old one, pass supersedesId to mark it.",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "warden_memory_recall",
    cd("Recall relevant memories for current task. Use BEFORE starting work to find past decisions."),
    {
      query: z
        .string()
        .describe(
          "What you're looking for (e.g., 'payments', 'auth', 'database choice')",
        ),
      limit: z
        .number()
        .optional()
        .describe("Max memories to return (default 10)"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const results = projectMemory.recall(args.query, args.limit ?? 10);
      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: `No memories found for "${args.query}"` },
          ],
        };
      }
      const lines = [
        `Warden memory — ${results.length} memories for "${args.query}"`,
        "",
        ...results.map(
          (m) =>
            `  [${m.category}] ${m.title}\n    ${m.body}\n    tags: ${m.tags.join(", ") || "none"} | accessed: ${m.accessCount}x | ${m.timestamp.slice(0, 10)}`,
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ---- P1: Failed approach recall ----
  server.tool(
    "warden_memory_failed_approaches",
    cd("Find past failed approaches relevant to a task. Use BEFORE attempting an approach to check if it was tried before and failed. Prevents repeating known-bad solutions."),
    {
      query: z
        .string()
        .describe("What you're about to try (e.g., 'Redis sessions', 'regex parsing')"),
      limit: z
        .number()
        .optional()
        .describe("Max failures to return (default 5)"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const failures = projectMemory.findFailedApproaches(
        args.query,
        args.limit ?? 5,
      );
      if (failures.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No failed approaches found for "${args.query}". Safe to try.`,
            },
          ],
        };
      }
      const lines = [
        `WARNING: ${failures.length} failed approach(es) found for "${args.query}":`,
        "",
        ...failures.map(
          (f) =>
            `  [${f.category}] ${f.title}\n    ${f.body}\n    evidence: ${f.evidence.join(", ") || "none"} | ${f.timestamp.slice(0, 10)}`,
        ),
        "",
        "Consider a different approach, or call warden_memory_save with supersedesId if you've found a working solution.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_memory_list",
    cd("List all stored memories. Use to review what decisions Warden remembers."),
    {
      limit: z
        .number()
        .optional()
        .describe("Max memories to return (default 50)"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const results = projectMemory.list(args.limit ?? 50);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const lines = [
        `Warden memory — ${results.length} memories stored`,
        "",
        ...results.map(
          (m) =>
            `  #${m.id} [${m.category}] ${m.title}  (${m.timestamp.slice(0, 10)}, accessed ${m.accessCount}x)`,
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_memory_forget",
    cd("Delete stored memory. Use when decision is outdated or wrong."),
    {
      id: z.number().describe("Memory ID to delete"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const deleted = projectMemory.forget(args.id);
      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Memory #${args.id} deleted.`
              : `Memory #${args.id} not found.`,
          },
        ],
      };
    },
  );

  // ---- P1: Decision lifecycle tools ----
  server.tool(
    "warden_memory_reaffirm",
    cd("Reaffirm a decision — signals this decision was referenced and found still valid. Increments reaffirm count. Call when a past decision is confirmed during a task."),
    {
      id: z.number().describe("Memory ID to reaffirm"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const ok = projectMemory.reaffirm(args.id);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Memory #${args.id} reaffirmed.`
              : `Memory #${args.id} not found or not active.`,
          },
        ],
      };
    },
  );

  server.tool(
    "warden_memory_archive",
    cd("Archive a decision — mark as expired (no longer relevant). Use instead of forget when the decision should be preserved for history but not surfaced."),
    {
      id: z.number().describe("Memory ID to archive"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const ok = projectMemory.archive(args.id);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Memory #${args.id} archived (status=expired).`
              : `Memory #${args.id} not found or not active.`,
          },
        ],
      };
    },
  );

  // ---- P1: Memory lifecycle — mark contested ----
  server.tool(
    "warden_memory_mark_contested",
    cd("Mark a decision as contested — signals disagreement. The decision stays visible but is flagged for review. Use when someone questions a decision but it's not yet resolved."),
    {
      id: z.number().describe("Memory ID to mark contested"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const ok = projectMemory.markContested(args.id);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Memory #${args.id} marked as contested.`
              : `Memory #${args.id} not found or not active.`,
          },
        ],
      };
    },
  );

  // ---- P1: Memory lifecycle — reject ----
  server.tool(
    "warden_memory_reject",
    cd("Reject a decision — mark as rejected (bad idea, do not proceed). Stronger than archive — the decision is explicitly wrong. Use when a decision is proven incorrect."),
    {
      id: z.number().describe("Memory ID to reject"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd)."),
    },
    async (args) => {
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      const ok = projectMemory.reject(args.id);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Memory #${args.id} rejected.`
              : `Memory #${args.id} not found or not active.`,
          },
        ],
      };
    },
  );

  // ---- Verification upgrade: task outcome tracking ----

  server.tool(
    "warden_record_outcome",
    cd("Record task outcome (success/failure). Warden correlates with pruning to detect regressions. Call AFTER completing task."),
    {
      task: z
        .string()
        .describe("What the task was (e.g., 'fix null pointer in auth')"),
      success: z.boolean().describe("Did the task complete successfully?"),
      pruned: z
        .boolean()
        .describe("Was Warden pruning active during this task?"),
      tokensSaved: z
        .number()
        .optional()
        .describe("Tokens saved by pruning during this task"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for memory scoping (defaults to server cwd). Pass your project's root dir to ensure memories are scoped to the correct project."),
    },
    async (args) => {
      const projectTracker = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).tracker
        : tracker;
      const projectMemory = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).memory
        : memory;
      projectTracker.record({
        task: args.task,
        success: args.success,
        pruned: args.pruned,
        tokensSaved: args.tokensSaved,
      });

      // Auto-save failures as memories so the agent doesn't repeat mistakes.
      // This makes memory automatic — the agent doesn't need to call
      // warden_memory_save separately for failure patterns.
      let autoSaved = "";
      if (!args.success) {
        try {
          const id = projectMemory.save({
            category: "finding",
            title: `Failed: ${args.task}`,
            body: `Task "${args.task}" failed. Pruning was ${args.pruned ? "active" : "inactive"}. Review the approach before retrying.`,
            tags: ["failure", "auto-saved"],
            source: "warden_record_outcome (auto)",
          });
          autoSaved = ` Memory #${id} auto-saved (failure pattern).`;
        } catch {
          // Memory save is best-effort — don't fail the outcome recording.
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Outcome recorded. ${projectTracker.summary()}${autoSaved}`,
          },
        ],
      };
    },
  );

  server.tool(
    "warden_outcome_stats",
    cd("Task outcome stats: success rates with/without pruning, regression detection."),
    {
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for scoping (defaults to server cwd). Pass your project's root dir to ensure stats are scoped to the correct project."),
    },
    async (args) => {
      const projectTracker = args.repoRoot
        ? (await getProjectStore(args.repoRoot)).tracker
        : tracker;
      return {
        content: [{ type: "text", text: projectTracker.summary() }],
      };
    },
  );

  // ---- Layer 4: File compression ----
  server.tool(
    "warden_compress",
    cd("Compress a markdown/text file — strips filler, preserves code/paths/commands verbatim. Use on memory files (CLAUDE.md, AGENTS.md) to save tokens every future session."),
    {
      filePath: z
        .string()
        .describe("Path to file to compress (absolute or relative to cwd)."),
      level: z
        .enum(["lite", "full", "ultra"])
        .optional()
        .describe("Compression level (default: full)."),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, return preview without writing."),
    },
    async (args) => {
      const { readFileSync, writeFileSync, existsSync } =
        await import("node:fs");
      const { resolve, basename } = await import("node:path");
      const filePath = resolve(args.filePath);
      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
        };
      }
      const original = readFileSync(filePath, "utf8");
      const result = compressFile(original, args.level ?? "full");
      if (!result.validationOk) {
        const errs = result.validationErrors.join("\n");
        return {
          content: [{ type: "text", text: `Validation failed:\n${errs}` }],
        };
      }
      if (!args.dryRun) {
        // Back up original
        const backupPath = `${filePath}.original`;
        if (!existsSync(backupPath)) {
          writeFileSync(backupPath, original);
        }
        writeFileSync(filePath, result.compressed);
      }
      const lines = [
        `Warden compress — ${basename(filePath)} (${args.level ?? "full"})`,
        `  ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.reductionPct}% reduction)`,
        `  ${result.preservedSegments} segments preserved verbatim, validation: ✓`,
        args.dryRun
          ? "  (dry run — file not modified)"
          : `  written to ${filePath}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ---- Layer 0: Code intelligence (structural queries) ----

  server.tool(
    "warden_index",
    cd("Index the current project's code structure — functions, classes, imports, call sites. Run once before using warden_call_graph, warden_impact, or warden_architecture. Incremental: only changed files are re-parsed."),
    {
      repoRoot: z
        .string()
        .optional()
        .describe("Project root to index (defaults to cwd)"),
      force: z
        .boolean()
        .optional()
        .describe("Force full re-index (ignore cached mtimes)"),
      maxFiles: z
        .number()
        .optional()
        .describe("Maximum files to index (default 10000)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const indexer = new CodeIndex(warden.store);
      const result = await indexer.index({
        repoRoot,
        force: args.force,
        maxFiles: args.maxFiles,
      });
      const lines = [
        `Warden index — ${result.filesParsed}/${result.filesScanned} files parsed in ${result.durationMs}ms`,
        `  symbols: ${result.symbolsFound}  imports: ${result.importsFound}  calls: ${result.callsFound}`,
        result.skipped.length > 0
          ? `  skipped: ${result.skipped.length} files`
          : "",
        "",
        "Now you can use:",
        "  warden_call_graph — who calls a function / what it calls",
        "  warden_impact — blast radius of changes to a file",
        "  warden_architecture — project overview in one call",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_call_graph",
    cd("Query the call graph: who calls a function, or what a function calls. Replaces dozens of grep/read cycles with one structural query. Run warden_index first."),
    {
      function: z
        .string()
        .describe("Function name (e.g., 'auth' or 'User.validate')"),
      direction: z
        .enum(["callers", "callees", "both"])
        .optional()
        .describe(
          "callers = who calls this, callees = what it calls (default: both)",
        ),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root (defaults to cwd)"),
      limit: z
        .number()
        .optional()
        .describe("Max results per direction (default 50)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const graph = new GraphQuery(warden.store, repoRoot);
      if (graph.isEmpty()) return emptyIndexResponse();
      const dir = args.direction ?? "both";
      const limit = args.limit ?? 50;
      const lines: string[] = [
        `Warden call graph — ${args.function} (${dir})`,
        "",
      ];

      if (dir === "callers" || dir === "both") {
        const callers = graph.callers(args.function, limit);
        lines.push(`Callers (${callers.length}):`);
        if (callers.length === 0) {
          lines.push("  (no callers found)");
        } else {
          for (const c of callers) {
            const sym = c.calleeSymbol
              ? ` → ${c.calleeSymbol.kind} ${c.calleeSymbol.name} (${c.calleeSymbol.filePath})`
              : "";
            lines.push(
              `  ${c.filePath}:${c.line}  ${c.callerName}() calls ${c.calleeName}()${sym}`,
            );
          }
        }
        lines.push("");
      }

      if (dir === "callees" || dir === "both") {
        const callees = graph.callees(args.function, limit);
        lines.push(`Callees (${callees.length}):`);
        if (callees.length === 0) {
          lines.push("  (no callees found)");
        } else {
          for (const c of callees) {
            const sym = c.calleeSymbol
              ? ` → ${c.calleeSymbol.kind} in ${c.calleeSymbol.filePath}:${c.calleeSymbol.startLine}`
              : "";
            lines.push(
              `  ${c.filePath}:${c.line}  ${c.callerName}() calls ${c.calleeName}()${sym}`,
            );
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_impact",
    cd("Impact analysis: what's affected by changes to a file? Shows direct dependents, affected callers, and transitive impact. Replaces reading every file that might be affected. Run warden_index first."),
    {
      filePath: z
        .string()
        .describe("Path to the changed file (absolute or relative to cwd)"),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root (defaults to cwd)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const graph = new GraphQuery(warden.store, repoRoot);
      if (graph.isEmpty()) return emptyIndexResponse();
      const result = graph.impact(args.filePath);
      const lines = [
        `Warden impact analysis — ${args.filePath}`,
        `  Risk: ${result.risk.toUpperCase()}`,
        "",
        `Direct dependents (${result.directDependents.length}):`,
        ...result.directDependents.slice(0, 15).map((f) => `  ${f}`),
        result.directDependents.length > 15
          ? `  … and ${result.directDependents.length - 15} more`
          : "",
        "",
        `Affected symbols (${result.affectedSymbols.length}):`,
        ...result.affectedSymbols
          .slice(0, 15)
          .map((s) => `  ${s.kind} ${s.name} (${s.filePath}:${s.startLine})`),
        result.affectedSymbols.length > 15
          ? `  … and ${result.affectedSymbols.length - 15} more`
          : "",
        "",
        `Affected callers (${result.affectedCallers.length}):`,
        ...result.affectedCallers
          .slice(0, 15)
          .map(
            (c) =>
              `  ${c.filePath}:${c.line}  ${c.callerName}() → ${c.calleeName}()`,
          ),
        result.affectedCallers.length > 15
          ? `  … and ${result.affectedCallers.length - 15} more`
          : "",
        "",
        `Transitive dependents (${result.transitiveDependents.length}):`,
        ...result.transitiveDependents.slice(0, 10).map((f) => `  ${f}`),
        result.transitiveDependents.length > 10
          ? `  … and ${result.transitiveDependents.length - 10} more`
          : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_architecture",
    cd("Project architecture overview in one call: languages, packages, entry points, hotspots, total counts. Replaces reading 20 files to understand project structure. Run warden_index first."),
    {
      repoRoot: z
        .string()
        .optional()
        .describe("Project root (defaults to cwd)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const graph = new GraphQuery(warden.store, repoRoot);
      if (graph.isEmpty()) return emptyIndexResponse();
      const arch = graph.architecture();
      const lines = [
        `Warden architecture — ${arch.totalFiles} files, ${arch.totalSymbols} symbols, ${arch.totalCalls} calls`,
        "",
        "Languages:",
        ...arch.languages.map((l) => `  ${l.language}: ${l.fileCount} files`),
        "",
        "Packages (top 15):",
        ...arch.packages.map(
          (p) =>
            `  ${p.name.padEnd(20)} ${p.fileCount} files, ${p.symbolCount} symbols`,
        ),
        "",
        `Entry points (${arch.entryPoints.length}):`,
        ...arch.entryPoints
          .slice(0, 20)
          .map(
            (s) =>
              `  ${s.kind} ${s.name} (${s.filePath}:${s.startLine})${s.async ? " async" : ""}`,
          ),
        arch.entryPoints.length > 20
          ? `  … and ${arch.entryPoints.length - 20} more`
          : "",
        "",
        "Hotspots (most referenced):",
        ...arch.hotspots.map(
          (h) =>
            `  ${h.filePath.padEnd(40)} ${h.symbolCount} symbols, ${h.callerCount} callers`,
        ),
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_search_symbols",
    cd("Search for symbols (functions, classes, types) by name pattern across the indexed project. Faster and more structured than grep for finding definitions. Run warden_index first."),
    {
      query: z
        .string()
        .describe(
          "Symbol name to search for (e.g., 'auth', 'User', 'validate')",
        ),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root (defaults to cwd)"),
      limit: z.number().optional().describe("Max results (default 30)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const graph = new GraphQuery(warden.store, repoRoot);
      if (graph.isEmpty()) return emptyIndexResponse();
      const results = graph.search(args.query, args.limit ?? 30);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols found matching "${args.query}". Run warden_index first.`,
            },
          ],
        };
      }
      const lines = [
        `Warden symbol search — ${results.length} results for "${args.query}"`,
        "",
        ...results.map(
          (s) =>
            `  ${s.kind.padEnd(10)} ${s.name}${s.className ? ` (${s.className})` : ""}  ${s.filePath}:${s.startLine}${s.exported ? " [exported]" : ""}`,
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "warden_dead_code",
    cd("Find functions with zero callers — potential dead code. Excludes entry points. Run warden_index first."),
    {
      repoRoot: z
        .string()
        .optional()
        .describe("Project root (defaults to cwd)"),
      limit: z.number().optional().describe("Max results (default 30)"),
    },
    async (args) => {
      const repoRoot = args.repoRoot ?? warden.repoRoot ?? process.cwd();
      const graph = new GraphQuery(warden.store, repoRoot);
      if (graph.isEmpty()) return emptyIndexResponse();
      const results = graph.deadCode(args.limit ?? 30);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No dead code found (or project not indexed — run warden_index first).",
            },
          ],
        };
      }
      const lines = [
        `Warden dead code detection — ${results.length} functions with zero callers`,
        "",
        ...results.map(
          (s) =>
            `  ${s.kind.padEnd(10)} ${s.name}  ${s.filePath}:${s.startLine}${s.exported ? " [exported]" : ""}`,
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ---- Session handoff ----
  server.tool(
    "warden_handoff",
    cd("Session handoff — continuity across sessions. Two modes: (1) READ mode (read=true, default at session start) returns the last generated handoff document so the next session picks up where the previous left off. (2) GENERATE mode (read=false, default at session end) distills memories, outcomes, files touched, and pruning decisions since the last handoff into a compact summary. Call READ at session start. Call GENERATE at session end, before context compaction, or after completing a significant task."),
    {
      read: z
        .boolean()
        .optional()
        .describe("true = return last handoff document (use at session start). false/omitted = generate new handoff (use at session end or before compaction)."),
      hours: z
        .number()
        .optional()
        .describe("Lookback window in hours for generate mode (default: 8, or since last handoff). Ignored in read mode."),
      repoRoot: z
        .string()
        .optional()
        .describe("Project root directory for scoping (defaults to server cwd). Pass your project's root dir to ensure handoff is scoped to the correct project."),
    },
    async (args) => {
      const { HandoffGenerator } = await import("../handoff/index.js");
      const projectStore = args.repoRoot
        ? await getProjectStore(args.repoRoot)
        : { store: warden.store };
      const gen = new HandoffGenerator(projectStore.store);

      // Read mode: return the last handoff without generating a new one
      if (args.read === true) {
        const last = gen.readLast();
        if (!last) {
          return {
            content: [
              {
                type: "text",
                text: "No previous handoff found. This is normal for the first session. Call warden_handoff (without read=true) at session end to generate one for the next session.",
              },
            ],
          };
        }
        return { content: [{ type: "text", text: last.document }] };
      }

      // Generate mode: create a new handoff
      const result = gen.generate(args.hours ?? 8);
      return { content: [{ type: "text", text: result.document }] };
    },
  );

  return { server, warden };
}

/**
 * Auto-initialize Warden in the current project if it hasn't been set up yet.
 *
 * When `warden serve` starts in a new project/space (one where `warden init`
 * was never run), this writes the rules files (CLAUDE.md, AGENTS.md,
 * .cursorrules, .devin/rules) so the agent knows to use Warden tools.
 * Also ensures the .warden/ directory exists for the SQLite database.
 *
 * This makes Warden truly plug-and-play: install once globally, and every
 * new project/space automatically gets rules files on first serve.
 * Idempotent — safe to run every time the server starts.
 */
function autoInitProject(): void {
  try {
    const repoRoot = findRepoRoot();
    if (!repoRoot) return;

    // Ensure .warden/ directory exists
    ensureWardenDir(repoRoot);

    // Check if ANY rules files already exist (check all known agent paths)
    const rulesFiles = [
      "CLAUDE.md",
      "AGENTS.md",
      ".cursorrules",
      ".devin/rules",
      ".clinerules",
      ".continuerules",
      "GEMINI.md",
      ".github/copilot-instructions.md",
      ".zedrules",
      "CONVENTIONS.md",
      ".goose/rules",
      ".openhands/rules",
      ".opencode/rules",
      ".mcprules",
    ];
    const hasAnyRules = rulesFiles.some((f) => existsSync(join(repoRoot, f)));

    if (!hasAnyRules) {
      // No rules files found — auto-write them
      writeRules(repoRoot);
      logger.info("auto-initialized warden rules in new project", { repoRoot });
    }
  } catch (err) {
    // Auto-init is best-effort — never block server startup
    logger.warn("auto-init failed (non-fatal)", { error: String(err) });
  }
}

/** Run the MCP server over stdio. Used by `warden serve` and by MCP clients. */
export async function runMcpServer(): Promise<void> {
  // Auto-initialize: write rules files if this is a new project/space
  autoInitProject();

  const { server, warden } = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("warden MCP server running on stdio", {
    rules: warden.status().length,
  });
  // Keep the process alive until the transport closes.
  return new Promise((resolve) => {
    transport.onclose = () => {
      warden.close();
      resolve();
    };
  });
}

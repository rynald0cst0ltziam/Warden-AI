/**
 * Wrapper tools — Warden's path to automatic pruning.
 *
 * Instead of requiring the agent to call a tool and then manually call
 * `warden_prune` on the output, these tools DO the work AND prune the output
 * before returning it. The agent calls `warden_grep` instead of its built-in
 * grep, and gets pruned results in one shot.
 *
 * Each wrapper:
 *   1. Executes the underlying operation (search, read, run)
 *   2. Classifies the task from the call parameters
 *   3. Prunes the raw output via the pruning engine
 *   4. Returns the pruned output + a summary of what was cut
 *
 * If a rule is in shadow mode, the raw output is returned (safe) and shadow
 * evidence is recorded. If active/canary, the pruned output is returned.
 */
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute, relative } from "node:path";
import { Warden } from "../warden.js";
import { rewriteCommand } from "../pruner/preprocess.js";
import type { CodeIndexForPruning } from "../pruner/types.js";

/**
 * Create a code index adapter for the fileread pruner.
 * Returns null if no index exists for this project.
 * The adapter wraps the SQLite store's index_symbols table.
 */
function createCodeIndexAdapter(
  warden: Warden,
  repoRoot: string,
): CodeIndexForPruning | null {
  return {
    hasIndex(root: string): boolean {
      try {
        const row = warden.store.db
          .prepare("SELECT COUNT(*) AS n FROM index_files WHERE project = ?")
          .get(root) as { n: number } | undefined;
        return (row?.n ?? 0) > 0;
      } catch {
        return false;
      }
    },
    getSymbolsForFile(
      filePath: string,
      root: string,
    ): Array<{
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
      params: string[];
      exported: boolean;
      isAsync: boolean;
      className: string | null;
    }> {
      try {
        const rows = warden.store.db
          .prepare(
            "SELECT name, kind, start_line, end_line, params_json, exported, is_async, class_name FROM index_symbols WHERE project = ? AND file_path = ? ORDER BY start_line",
          )
          .all(root, filePath) as {
          name: string;
          kind: string;
          start_line: number;
          end_line: number;
          params_json: string;
          exported: number;
          is_async: number;
          class_name: string | null;
        }[];
        return rows.map((r) => ({
          name: r.name,
          kind: r.kind,
          startLine: r.start_line,
          endLine: r.end_line,
          params: JSON.parse(r.params_json ?? "[]") as string[],
          exported: !!r.exported,
          isAsync: !!r.is_async,
          className: r.class_name,
        }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Check if ripgrep (rg) is available on the system.
 * Cached after first check.
 */
let rgAvailable: boolean | null = null;
function isRgAvailable(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 3000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Get .gitignore patterns from the search root, for use by ripgrep.
 * ripgrep respects .gitignore by default, so we just need to make sure
 * we're running from the right directory.
 */
import type { ToolType } from "../pruner/types.js";
import {
  buildWardenMeta,
  formatWardenAnnotation,
  formatWardenBadge,
  formatWardenCumulative,
  formatWardenCcr,
  formatWardenMetaJson,
  type WardenMeta,
} from "../pruner/types.js";
import { logger } from "../logging/index.js";

export interface WrapperResult {
  /** What gets sent to the model (pruned if active, raw if shadow). */
  output: string;
  /** Human-readable summary of what was cut. */
  summary: string;
  /** Token stats. */
  tokensFull: number;
  tokensPruned: number;
  /** Rule that handled this call. */
  ruleId: string;
  /** Whether pruning was applied. */
  applied: boolean;
  /** Guard check passed. */
  guardOk: boolean;
  /** Structured metadata for agent UI rendering. */
  wardenMeta: WardenMeta;
}

/** Common logic: run the pruner on raw output and return the shipped version. */
async function pruneAndShip(
  warden: Warden,
  toolType: ToolType,
  rawOutput: string,
  taskHint: string,
  toolName: string,
  pruneOptions?: import("../pruner/types.js").PruneOptions,
): Promise<WrapperResult> {
  const res = await warden.pruneCall({
    toolType,
    rawOutput,
    taskHint,
    toolName,
    pruneOptions,
  });
  const wardenMeta = buildWardenMeta({
    result: res.result,
    stage: res.stage,
    applied: res.applied,
  });
  return {
    output: res.shipped,
    summary: res.result.removed.summary,
    tokensFull: res.result.tokensFull,
    tokensPruned: res.result.tokensPruned,
    ruleId: res.result.ruleId,
    applied: res.applied,
    guardOk: res.result.guardOk,
    wardenMeta,
  };
}

function formatOutput(r: WrapperResult, cumulativeSaved?: number): string {
  // Badge at TOP — visible first, even in collapsed tool output
  const top: string[] = [
    formatWardenBadge(r.wardenMeta),
    `‹warden› ${r.summary}`,
  ];
  if (r.wardenMeta.ccrHash) {
    top.push(formatWardenCcr(r.wardenMeta.ccrHash));
  }
  if (cumulativeSaved !== undefined && cumulativeSaved > 0) {
    top.push(formatWardenCumulative(cumulativeSaved));
  }

  const lines = [
    ...top,
    "",
    r.output,
    "",
    // Compact annotation + structured metadata at bottom for machine parsing
    formatWardenAnnotation(r.wardenMeta),
    formatWardenMetaJson(r.wardenMeta),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// warden_grep — search files for a pattern, return pruned results
// ---------------------------------------------------------------------------

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

/**
 * Search using ripgrep — fast, respects .gitignore, handles large repos.
 * Falls back to nativeGrep if rg is not available.
 */
function rgGrep(
  pattern: string,
  searchPath: string,
  glob?: string,
  ignoreCase?: boolean,
  maxResults = 500,
): string {
  const args: string[] = [
    "--no-heading",
    "--line-number",
    "--color=never",
    `-M`,
    "500", // max line length
    `-m`,
    String(maxResults), // max matches
  ];
  if (ignoreCase) args.push("-i");
  if (glob) {
    // Convert simple glob patterns to ripgrep's --glob format
    // *.ts → *.ts, **/*.ts → **/*.ts (rg handles both)
    args.push("--glob", glob);
  }
  // Common ignore patterns (rg already respects .gitignore)
  args.push("--glob", "!node_modules");
  args.push("--glob", "!.git");
  args.push("--glob", "!dist");
  args.push("--glob", "!.next");
  args.push("--glob", "!.warden");
  args.push("--glob", "!build");
  args.push("--glob", "!coverage");
  // Skip binary files
  args.push("--no-binary");
  args.push("--text"); // treat all files as text

  args.push(pattern, searchPath);

  try {
    const output = execFileSync("rg", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // rg outputs path:line:content — normalize paths to be relative
    const lines = output.split(/\r?\n/).filter((l) => l.trim());
    const normalized = lines.map((line) => {
      // rg outputs absolute paths when given absolute search path
      // Convert to relative for consistency with nativeGrep
      if (isAbsolute(searchPath) && line.startsWith(searchPath)) {
        return relative(searchPath, line).replace(/\\/g, "/");
      }
      return line;
    });
    return normalized.join("\n");
  } catch (err) {
    // rg returns exit code 1 when no matches found — that's not an error
    if ((err as { status?: number }).status === 1) return "";
    // Real error — fall back to nativeGrep
    return nativeGrep(pattern, searchPath, glob, ignoreCase, maxResults);
  }
}

/** Node-native recursive grep — fallback when ripgrep is not available. */
function nativeGrep(
  pattern: string,
  searchPath: string,
  glob?: string,
  ignoreCase?: boolean,
  maxResults = 500,
): string {
  const flags = ignoreCase ? "i" : "";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }

  const results: string[] = [];
  const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    ".warden",
    ".cursor",
    ".devin",
    ".codeium",
    "out",
    "build",
    "coverage",
  ]);

  function walk(dir: string): void {
    if (results.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (results.length >= maxResults) return;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        walk(full);
      } else if (stat.isFile()) {
        if (glob) {
          // Simple glob match: *.ts → ends with .ts, **/*.ts → ends with .ts
          const g = glob
            .replace(/^\*\*\/?/, "")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
          if (!new RegExp(g + "$").test(name)) continue;
        }
        // Skip binary-ish files by extension
        if (
          /\.(png|jpg|jpeg|gif|bmp|ico|pdf|zip|tar|gz|exe|dll|so|dylib|woff|woff2|ttf|eot|mp4|mp3|webp)$/.test(
            name,
          )
        )
          continue;
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) return;
          if (regex.test(lines[i]!)) {
            const rel = relative(searchPath, full).replace(/\\/g, "/");
            results.push(`${rel}:${i + 1}:${lines[i]!.trim()}`);
          }
        }
      }
    }
  }

  walk(searchPath);
  return results.join("\n");
}

/**
 * Search code — uses ripgrep when available (fast, respects .gitignore),
 * falls back to Node-native recursive grep otherwise.
 */
function searchCode(
  pattern: string,
  searchPath: string,
  glob?: string,
  ignoreCase?: boolean,
  maxResults = 500,
): string {
  if (isRgAvailable()) {
    return rgGrep(pattern, searchPath, glob, ignoreCase, maxResults);
  }
  return nativeGrep(pattern, searchPath, glob, ignoreCase, maxResults);
}

export async function wardenGrep(
  warden: Warden,
  args: GrepArgs,
): Promise<string> {
  const searchPath = args.path ?? process.cwd();
  const absPath = isAbsolute(searchPath)
    ? searchPath
    : resolve(process.cwd(), searchPath);

  if (!existsSync(absPath)) {
    return `Error: search path not found: ${absPath}`;
  }

  const raw = searchCode(
    args.pattern,
    absPath,
    args.glob,
    args.ignoreCase,
    args.maxResults ?? 500,
  );

  if (!raw.trim()) {
    return `No matches found for pattern "${args.pattern}" in ${searchPath}.`;
  }

  const result = await pruneAndShip(
    warden,
    "grep",
    raw,
    `search for ${args.pattern}`,
    "warden_grep",
  );
  return formatOutput(result, warden.totalTokensSaved());
}

// ---------------------------------------------------------------------------
// warden_file_read — read a file, return pruned content
// ---------------------------------------------------------------------------

export interface FileReadArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export async function wardenFileRead(
  warden: Warden,
  args: FileReadArgs,
): Promise<string> {
  const absPath = isAbsolute(args.filePath)
    ? args.filePath
    : resolve(process.cwd(), args.filePath);

  if (!existsSync(absPath)) {
    return `Error: file not found: ${absPath}`;
  }

  const stat = statSync(absPath);
  if (stat.isDirectory()) {
    return `Error: path is a directory, not a file: ${absPath}`;
  }

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    return `Error: could not read file: ${String(err)}`;
  }

  // If the caller requested a line range, slice before pruning.
  if (args.startLine !== undefined || args.endLine !== undefined) {
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, (args.startLine ?? 1) - 1);
    const end = args.endLine ?? lines.length;
    raw = lines.slice(start, end).join("\n");
  }

  const fileName = absPath.split(/[\\/]/).pop() ?? absPath;
  const repoRoot = warden.repoRoot ?? process.cwd();
  const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");

  // Build code index adapter for AST-based outlines (if index exists)
  const codeIndex = createCodeIndexAdapter(warden, repoRoot);

  const result = await pruneAndShip(
    warden,
    "file-read",
    raw,
    `read ${fileName}`,
    "warden_file_read",
    codeIndex
      ? {
          codeIndex,
          filePath: relPath,
          repoRoot,
        }
      : undefined,
  );
  return formatOutput(result, warden.totalTokensSaved());
}

// ---------------------------------------------------------------------------
// warden_run_tests — run a test command, return pruned output
// ---------------------------------------------------------------------------

export interface RunTestsArgs {
  command?: string;
  cwd?: string;
}

export async function wardenRunTests(
  warden: Warden,
  args: RunTestsArgs,
): Promise<string> {
  const originalCmd = args.command ?? "npm test";
  const cmd = rewriteCommand(originalCmd);
  const cwd = args.cwd ?? process.cwd();

  let raw: string;
  let exitCode = 0;
  try {
    raw = execSync(cmd, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Non-zero exit is normal for test runs with failures — capture stdout.
    raw = (err as { stdout?: string }).stdout ?? "";
    exitCode = (err as { status?: number }).status ?? 1;
    if (!raw && (err as { stderr?: string }).stderr) {
      raw = (err as { stderr?: string }).stderr ?? "";
    }
  }

  if (!raw.trim()) {
    return `Test command "${cmd}" produced no output (exit code ${exitCode}).`;
  }

  const result = await pruneAndShip(
    warden,
    "test-log",
    raw,
    "run tests and fix failures",
    "warden_run_tests",
  );
  const header = `Test command: ${cmd} (exit code ${exitCode})\n\n`;
  return header + formatOutput(result, warden.totalTokensSaved());
}

// ---------------------------------------------------------------------------
// warden_run_command — run any shell command, return pruned output
// ---------------------------------------------------------------------------

export interface RunCommandArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

export async function wardenRunCommand(
  warden: Warden,
  args: RunCommandArgs,
): Promise<string> {
  const cwd = args.cwd ?? process.cwd();
  const timeout = args.timeout ?? 60000;
  const cmd = rewriteCommand(args.command);

  let raw: string;
  let exitCode = 0;
  try {
    raw = execSync(cmd, {
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    raw = (err as { stdout?: string }).stdout ?? "";
    exitCode = (err as { status?: number }).status ?? 1;
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr) {
      raw = raw + (raw ? "\n" : "") + stderr;
    }
    if (!raw) {
      return `Command "${cmd}" failed (exit code ${exitCode}) with no output.`;
    }
  }

  const result = await pruneAndShip(
    warden,
    "shell-output",
    raw,
    `run: ${cmd}`,
    "warden_run_command",
  );
  const header = `Command: ${cmd} (exit code ${exitCode})\n\n`;
  return header + formatOutput(result, warden.totalTokensSaved());
}

export { formatOutput as formatWrapperOutput };

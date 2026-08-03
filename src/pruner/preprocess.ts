/**
 * Output preprocessing — runs BEFORE the pruning module.
 *
 * These transformations are safe rewrites that reduce token count without
 * changing meaning. They run on the raw output before pruning, so the trust
 * guard still verifies that pruning only removes from the preprocessed output.
 *
 * Pipeline (each stage is conservative — if it would grow the output, it
 * returns the input unchanged):
 *
 *   1. ANSI escape stripping     — remove terminal color codes
 *   2. Path shortening           — project-root prefixes → relative paths
 *   3. JSON cleanup              — remove null/empty/false values from JSON
 *   4. Whitespace normalization  — collapse runs of blank lines, trim trailing
 *
 * Each stage logs how many bytes/tokens it saved.
 */
import { logger } from "../logging/index.js";

// ---------------------------------------------------------------------------
// 1. ANSI escape stripping
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape sequences from terminal output.
 *
 * Matches:
 * - CSI sequences: \x1b[...m (colors, cursor moves, etc.)
 * - OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\ (terminal title, hyperlinks)
 * - Other ESC sequences: \x1b... (single-char escapes)
 * - 8-bit CSI: \x9b...
 *
 * This is the same approach used by OpenToken, ATR, and every terminal
 * sanitizer. ANSI codes are purely decorative — they carry zero semantic
 * information and waste tokens (each escape sequence is 4-15 tokens).
 */
export function stripAnsi(text: string): string {
  // CSI sequences: ESC [ ... <0x40-0x7E>
  let result = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  // OSC sequences: ESC ] ... BEL or ESC ] ... ESC \
  result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

  // Other ESC sequences: ESC followed by single char
  result = result.replace(/\x1b[()][AB012]|\x1b[=>]/g, "");

  // 8-bit CSI (rare, but some terminals emit it)
  result = result.replace(/\x9b[0-9;]*[A-Za-z]/g, "");

  // Carriage returns (Windows line endings already handled by split, but
  // bare CR from progress bars should be cleaned)
  result = result.replace(/\r(?!\n)/g, "");

  return result;
}

// ---------------------------------------------------------------------------
// 2. Path shortening
// ---------------------------------------------------------------------------

/**
 * Shorten absolute paths to relative paths from the project root.
 *
 * Example:
 *   /Users/alice/myproject/src/main.ts → src/main.ts
 *   C:\Users\alice\myproject\src\main.ts → src/main.ts
 *
 * This saves significant tokens on file listings, grep output, stack traces,
 * and compiler errors — all of which repeat the full project path on every
 * line.
 *
 * We detect the project root from the longest common prefix of absolute paths
 * in the output. This is more reliable than guessing from cwd, because the
 * output might come from a different directory.
 */
export function shortenPaths(text: string): string {
  // Match absolute paths (Unix and Windows)
  const unixPathRe =
    /(?:^|[\s:(\[])(\/(?:Users|home|root|tmp|var|opt|usr|etc|mnt|media)\/[^\s:)\]]+)/g;
  const winPathRe = /(?:^|[\s:(\[])([A-Z]:\\[^\s:)\]]+)/g;

  const allPaths: string[] = [];

  for (const m of text.matchAll(unixPathRe)) {
    if (m[1]) allPaths.push(m[1]);
  }
  for (const m of text.matchAll(winPathRe)) {
    if (m[1]) allPaths.push(m[1]);
  }

  if (allPaths.length < 2) {
    // Not enough paths to detect a common prefix — skip
    return text;
  }

  // Find the longest common directory prefix
  const commonPrefix = longestCommonDirPrefix(allPaths);
  if (!commonPrefix || commonPrefix.length < 8) {
    // Prefix too short to be meaningful (e.g., just "/")
    return text;
  }

  // Replace all occurrences of the prefix with "."
  // Use a global regex, escaping special chars
  const escaped = commonPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "g");
  let result = text.replace(re, "");

  // Clean up leading slashes left behind (e.g., "/src/main.ts" → "src/main.ts")
  // But only when the slash is at the start of a path context, not in URLs
  result = result.replace(/([: (\[])\/([a-zA-Z0-9_])/g, "$1$2");

  return result;
}

/** Find the longest common directory prefix across a list of paths. */
function longestCommonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return "";

  // Normalize separators to forward slash for comparison
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));

  // Find common prefix character by character
  const first = normalized[0]!;
  let prefixLen = 0;
  for (let i = 0; i < first.length; i++) {
    const ch = first[i];
    if (!ch) break;
    if (normalized.every((p) => p[i] === ch)) {
      prefixLen = i + 1;
    } else {
      break;
    }
  }

  // Trim back to the last directory separator
  const prefix = first.slice(0, prefixLen);
  const lastSlash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  if (lastSlash < 0) return "";

  // Use the original separator from the first path
  const firstPath = paths[0]!;
  return firstPath.slice(0, lastSlash + 1);
}

// ---------------------------------------------------------------------------
// 3. JSON cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up JSON output by removing null, empty, and false values that add
 * tokens without adding information.
 *
 * Only applies to output that parses as valid JSON. If parsing fails, the
 * input is returned unchanged.
 *
 * Removes:
 * - null values
 * - empty arrays []
 * - empty objects {}
 * - empty strings ""
 * - false boolean values (keeps true — true is informative, false is default)
 *
 * Preserves:
 * - All non-empty values
 * - The structure (keys, nesting)
 * - Numbers (including 0 — 0 is informative)
 */
export function cleanJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return text;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }

  const cleaned = removeEmptyValues(parsed);
  if (cleaned === undefined) return text;

  // Pretty-print the cleaned result for readability
  const result = JSON.stringify(cleaned, null, 2);

  // Conservative: if cleanup grew the output (comparing compact forms to
  // account for pretty-printing overhead), return original
  const compactCleaned = JSON.stringify(cleaned);
  const compactOriginal = JSON.stringify(parsed);
  if (compactCleaned.length >= compactOriginal.length) {
    return text;
  }

  return result;
}

/** Recursively remove null, empty, and false values from a JSON structure. */
function removeEmptyValues(value: unknown): unknown {
  if (value === null) return undefined;
  if (value === false) return undefined;
  if (value === "") return undefined;

  if (Array.isArray(value)) {
    const cleaned = value.map(removeEmptyValues).filter((v) => v !== undefined);
    return cleaned.length === 0 ? undefined : cleaned;
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const cleaned = removeEmptyValues(val);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// 4. Whitespace normalization
// ---------------------------------------------------------------------------

/**
 * Normalize whitespace in tool output:
 * - Collapse 3+ blank lines to 1
 * - Trim trailing whitespace on each line
 * - Remove leading/trailing blank lines
 *
 * This is safe because blank lines carry no semantic information.
 */
export function normalizeWhitespace(text: string): string {
  let result = text;

  // Trim trailing whitespace on each line
  result = result.replace(/[ \t]+$/gm, "");

  // Collapse 3+ blank lines to 1
  result = result.replace(/\n{3,}/g, "\n\n");

  // Remove leading blank lines
  result = result.replace(/^\n+/, "");

  // Remove trailing blank lines
  result = result.replace(/\n+$/, "\n");

  return result;
}

// ---------------------------------------------------------------------------
// 5. Pre-call command rewrites
// ---------------------------------------------------------------------------

/**
 * Rewrite a shell command before execution to produce less verbose output.
 *
 * This adds --quiet/--silent/--no-ansi flags to known commands, reducing the
 * raw output BEFORE it's even generated. Less output = less to prune.
 *
 * Inspired by OpenToken's 46 pre-call rewrite patterns. We only add flags
 * that are universally safe — they suppress decorative output, not data.
 *
 * Returns the rewritten command. If no rewrite applies, returns the original.
 */
export function rewriteCommand(command: string): string {
  // npm: add --silent (suppresses progress, keeps errors)
  if (
    /\bnpm\s+(install|ci|update)\b/.test(command) &&
    !/--silent|--quiet|-s\b/.test(command)
  ) {
    return command.replace(/\bnpm\s+(install|ci|update)\b/, "npm $1 --silent");
  }

  // npm test/run: add --silent (suppresses npm's own output, keeps test output)
  if (
    /\bnpm\s+(test|run|run-script)\b/.test(command) &&
    !/--silent|--quiet|-s\b/.test(command)
  ) {
    return command.replace(
      /\bnpm\s+(test|run|run-script)\b/,
      "npm $1 --silent",
    );
  }

  // yarn: add --silent
  if (
    /\byarn\s+(install|add|remove|test|run)\b/.test(command) &&
    !/--silent/.test(command)
  ) {
    return command.replace(
      /\byarn\s+(install|add|remove|test|run)\b/,
      "yarn $1 --silent",
    );
  }

  // pnpm: add --silent
  if (
    /\bpnpm\s+(install|add|remove|test|run)\b/.test(command) &&
    !/--silent/.test(command)
  ) {
    return command.replace(
      /\bpnpm\s+(install|add|remove|test|run)\b/,
      "pnpm $1 --silent",
    );
  }

  // git diff: add --no-color
  if (/\bgit\s+diff\b/.test(command) && !/--no-color/.test(command)) {
    return command.replace(/\bgit\s+diff\b/, "git diff --no-color");
  }

  // git log: add --no-color
  if (/\bgit\s+log\b/.test(command) && !/--no-color/.test(command)) {
    return command.replace(/\bgit\s+log\b/, "git log --no-color");
  }

  // git show: add --no-color
  if (/\bgit\s+show\b/.test(command) && !/--no-color/.test(command)) {
    return command.replace(/\bgit\s+show\b/, "git show --no-color");
  }

  // docker: add --no-color where supported
  if (
    /\bdocker\s+(ps|images|logs)\b/.test(command) &&
    !/--no-color/.test(command)
  ) {
    return command.replace(
      /\bdocker\s+(ps|images|logs)\b/,
      "docker $1 --no-color",
    );
  }

  // cargo: add --quiet
  if (
    /\bcargo\s+(build|test|check|clippy|run)\b/.test(command) &&
    !/--quiet|-q\b/.test(command)
  ) {
    return command.replace(
      /\bcargo\s+(build|test|check|clippy|run)\b/,
      "cargo $1 --quiet",
    );
  }

  // pip: add --quiet
  if (/\bpip\s+install\b/.test(command) && !/--quiet|-q\b/.test(command)) {
    return command.replace(/\bpip\s+install\b/, "pip install --quiet");
  }

  // go test: add -q (quiet)
  if (/\bgo\s+test\b/.test(command) && !/--quiet|-q\b/.test(command)) {
    return command.replace(/\bgo\s+test\b/, "go test -q");
  }

  // pytest: add -q (quiet)
  if (/\bpytest\b/.test(command) && !/--quiet|-q\b/.test(command)) {
    return command.replace(/\bpytest\b/, "pytest -q");
  }

  return command;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export interface PreprocessResult {
  output: string;
  stages: Array<{ name: string; bytesBefore: number; bytesAfter: number }>;
}

/**
 * Run the full preprocessing pipeline on raw tool output.
 *
 * Each stage is conservative — if it would grow the output, it returns the
 * input unchanged. The stages run in order: ANSI strip → path shorten →
 * JSON cleanup → whitespace normalize.
 */
export function preprocessOutput(raw: string): PreprocessResult {
  const stages: PreprocessResult["stages"] = [];
  let output = raw;

  // Stage 1: ANSI stripping
  const beforeAnsi = output.length;
  output = stripAnsi(output);
  if (output.length !== beforeAnsi) {
    stages.push({
      name: "ansi-strip",
      bytesBefore: beforeAnsi,
      bytesAfter: output.length,
    });
  }

  // Stage 2: Path shortening
  const beforePaths = output.length;
  output = shortenPaths(output);
  if (output.length !== beforePaths) {
    stages.push({
      name: "path-shorten",
      bytesBefore: beforePaths,
      bytesAfter: output.length,
    });
  }

  // Stage 3: JSON cleanup
  const beforeJson = output.length;
  output = cleanJson(output);
  if (output.length !== beforeJson) {
    stages.push({
      name: "json-clean",
      bytesBefore: beforeJson,
      bytesAfter: output.length,
    });
  }

  // Stage 4: Whitespace normalization
  const beforeWs = output.length;
  output = normalizeWhitespace(output);
  if (output.length !== beforeWs) {
    stages.push({
      name: "whitespace",
      bytesBefore: beforeWs,
      bytesAfter: output.length,
    });
  }

  if (stages.length > 0) {
    logger.debug("preprocessing applied", {
      stages: stages
        .map((s) => `${s.name}:${s.bytesBefore}→${s.bytesAfter}`)
        .join(","),
    });
  }

  return { output, stages };
}

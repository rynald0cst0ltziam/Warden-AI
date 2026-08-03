/**
 * file-read pruning.
 *
 * Strategy: if the file is large and only part is relevant (e.g. one function
 * named in the task hint), return that slice plus a collapsed outline of the
 * rest — never the whole file. Code is never rewritten; the slice is verbatim
 * and the outline is built only from existing structural header lines.
 *
 * When a code index is available (opts.codeIndex), outlines use tree-sitter-
 * parsed symbols instead of regex matching — giving richer outlines with
 * parameter lists, export status, and async markers.
 */
import type {
  PruneModule,
  PruneOptions,
  PruneResult,
  RemovedSummary,
  CodeIndexForPruning,
} from "../types.js";
import { approxTokens } from "../types.js";
import { annotation } from "../guard.js";
import type { TaskContext } from "../../classifier/types.js";

/** Structural header patterns used to build the outline. Lines are kept verbatim. */
const HEADER_RE =
  /^\s*(export\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|impl|pub fn|fn|const|public|private|protected|static)\b.*$/;

/** A symbol from the code index, converted to an outline entry. */
interface AstOutlineEntry {
  /** 1-based line number of the symbol declaration. */
  line: number;
  /** Formatted signature string (e.g. "export async function login(user: string): Promise<Auth>"). */
  header: string;
}

/**
 * Format a code index symbol as a compact signature string.
 * Example: "export async function login(user: string, pass: string)"
 */
function formatAstSymbol(sym: {
  name: string;
  kind: string;
  params: string[];
  exported: boolean;
  isAsync: boolean;
  className: string | null;
}): string {
  const parts: string[] = [];
  if (sym.exported) parts.push("export");
  if (sym.isAsync) parts.push("async");
  parts.push(sym.kind);
  // For methods, prefix with class name
  const name = sym.className ? `${sym.className}.${sym.name}` : sym.name;
  const params = sym.params.length > 0 ? `(${sym.params.join(", ")})` : "()";
  return `${parts.join(" ")} ${name}${params}`;
}

/**
 * Get AST-based outline entries for a line range using the code index.
 * Returns entries sorted by line number, with formatted signatures.
 */
function astOutlineForRange(
  codeIndex: CodeIndexForPruning,
  filePath: string,
  repoRoot: string,
  startLine: number,
  endLine: number,
): AstOutlineEntry[] {
  const allSymbols = codeIndex.getSymbolsForFile(filePath, repoRoot);
  // Filter to symbols whose start_line falls within [startLine, endLine]
  return allSymbols
    .filter((s) => s.startLine >= startLine && s.startLine <= endLine)
    .map((s) => ({
      line: s.startLine,
      header: formatAstSymbol(s),
    }))
    .sort((a, b) => a.line - b.line);
}

function findRelevanceRange(
  lines: string[],
  task: TaskContext,
): { start: number; end: number } | null {
  const hint = task.relevanceHint.toLowerCase();
  const tokens = hint.split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return null;
  // Find the first line that mentions a hint token AND looks like a header,
  // or the first line mentioning a hint token at all.
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase();
    if (tokens.some((t) => low.includes(t))) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return null;
  // Expand to the surrounding top-level block: from the nearest preceding
  // header to the next header at the same or lesser indentation.
  let start = hit;
  while (start > 0 && !HEADER_RE.test(lines[start - 1]!)) start--;
  let end = hit;
  const indent = (lines[hit] ?? "").match(/^\s*/)?.[0].length ?? 0;
  for (let j = hit + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (HEADER_RE.test(line)) {
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (lineIndent <= indent) break;
    }
    end = j;
  }
  return { start, end };
}

function outline(lines: string[]): string[] {
  return lines.filter((l) => HEADER_RE.test(l));
}

export const fileReadModule: PruneModule = {
  toolType: "file-read",
  ruleId: "fileread.slice-outline.v1",
  name: "file-read slice + outline",
  prune(raw: string, task: TaskContext, opts: PruneOptions): PruneResult {
    const threshold = opts.fileReadLargeThresholdLines ?? 400;
    const tokensFull = approxTokens(raw);
    const lines = raw.split(/\r?\n/);

    // Check if we can use AST-based outlines
    const hasAstIndex =
      opts.codeIndex &&
      opts.filePath &&
      opts.repoRoot &&
      opts.codeIndex.hasIndex(opts.repoRoot);

    if (lines.length <= threshold) {
      return {
        toolType: "file-read",
        prunedOutput: raw,
        removed: {
          summary: "file under threshold, returned in full",
          tokensRemoved: 0,
          counts: { lines: lines.length },
        },
        tokensFull,
        tokensPruned: tokensFull,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    const range = findRelevanceRange(lines, task);
    if (!range) {
      // No anchor: return the outline + first chunk as a fallback.
      const head = lines.slice(0, Math.min(80, lines.length));
      const rest = lines.slice(80);
      const ol = outline(rest);
      const prunedOutput = [
        ...head,
        annotation(
          `… ${rest.length} lines omitted; ${ol.length} structural headers below`,
        ),
        ...ol.slice(0, 60),
      ].join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      const removed: RemovedSummary = {
        summary: `Large file (${lines.length} lines) with no relevance anchor; kept head + structural outline.`,
        tokensRemoved: tokensFull - tokensPruned,
        counts: {
          lines: lines.length,
          kept: head.length + Math.min(60, ol.length),
          outline: ol.length,
        },
      };
      return {
        toolType: "file-read",
        prunedOutput,
        removed,
        tokensFull,
        tokensPruned,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    const before = lines.slice(0, range.start);
    const slice = lines.slice(range.start, range.end + 1);
    const after = lines.slice(range.end + 1);

    // Build outlines — prefer AST-based if available, fall back to regex
    let olBefore: string[];
    let olAfter: string[];
    let outlineSource: "ast" | "regex";

    if (hasAstIndex && opts.filePath && opts.repoRoot) {
      // AST-based outlines: use symbol signatures with parameter lists
      // Line numbers are 1-based in the index, 0-based in our slices
      const beforeStart = 1;
      const beforeEnd = range.start + 1; // range.start is 0-based, convert to 1-based
      const afterStart = range.end + 2; // 1-based line after the slice
      const afterEnd = lines.length;

      const astBefore = astOutlineForRange(
        opts.codeIndex!,
        opts.filePath,
        opts.repoRoot,
        beforeStart,
        beforeEnd,
      );
      const astAfter = astOutlineForRange(
        opts.codeIndex!,
        opts.filePath,
        opts.repoRoot,
        afterStart,
        afterEnd,
      );

      olBefore = astBefore.map((e) => `L${e.line}: ${e.header}`);
      olAfter = astAfter.map((e) => `L${e.line}: ${e.header}`);
      outlineSource = "ast";
    } else {
      // Regex-based outlines (original behavior)
      olBefore = outline(before);
      olAfter = outline(after);
      outlineSource = "regex";
    }

    const prunedOutput = [
      ...(olBefore.length > 0
        ? [
            annotation(
              `… ${before.length} lines before relevance; ${olBefore.length} ${outlineSource === "ast" ? "symbol signatures" : "headers"}:`,
            ),
            ...olBefore.slice(0, 30),
          ]
        : []),
      ...slice,
      ...(olAfter.length > 0
        ? [
            annotation(
              `… ${after.length} lines after relevance; ${olAfter.length} ${outlineSource === "ast" ? "symbol signatures" : "headers"}:`,
            ),
            ...olAfter.slice(0, 30),
          ]
        : []),
    ].join("\n");

    const tokensPruned = approxTokens(prunedOutput);
    const removed: RemovedSummary = {
      summary: `Large file (${lines.length} lines); kept ${slice.length} relevant lines verbatim, replaced the rest with ${outlineSource === "ast" ? "AST symbol signatures" : "structural outlines"}.`,
      tokensRemoved: tokensFull - tokensPruned,
      counts: {
        lines: lines.length,
        kept: slice.length,
        outlineBefore: olBefore.length,
        outlineAfter: olAfter.length,
        astOutline: outlineSource === "ast" ? 1 : 0,
      },
    };
    return {
      toolType: "file-read",
      prunedOutput,
      removed,
      tokensFull,
      tokensPruned,
      ruleId: fileReadModule.ruleId,
      guardOk: true,
    };
  },
};

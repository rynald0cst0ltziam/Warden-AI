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
 *
 * AST-aware read modes (opts.readMode):
 * - "auto" (default): current behavior — slice + outline for large files
 * - "full": return raw content unchanged (no pruning)
 * - "outline": only structural header lines (verbatim), no bodies
 * - "signatures": only the first line of each AST symbol (verbatim), no bodies
 * - "symbol": one specific symbol by name + its full body (line range slice)
 * - "imports": only import statements (verbatim)
 *
 * Guard invariant: every non-annotation line in the pruned output must appear
 * verbatim in the raw input. AST outline entries use the ACTUAL file line at
 * the symbol's start line — never a synthetic formatted signature — so the
 * guard always passes.
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

/** Import statement patterns (TypeScript/JavaScript/Python/Go/Rust/Java). */
const IMPORT_RE =
  /^\s*(import\s+|from\s+\S+\s+import\s+|export\s+.*\s+from\s+|use\s+\S+::|#include\s+|require\s*\()/;

/**
 * Get the verbatim line from the raw content at a 1-based line number.
 * Returns null if the line is out of range or blank.
 */
function verbatimLine(lines: string[], line1Based: number): string | null {
  const idx = line1Based - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const line = lines[idx]!;
  if (line.trim().length === 0) return null;
  return line;
}

/**
 * Get AST-based outline entries for a line range using the code index.
 * Returns the VERBATIM file line at each symbol's start line — not a
 * synthetic formatted signature. This ensures the guard invariant holds.
 */
function astOutlineForRange(
  codeIndex: CodeIndexForPruning,
  filePath: string,
  repoRoot: string,
  startLine: number,
  endLine: number,
  lines: string[],
): string[] {
  const allSymbols = codeIndex.getSymbolsForFile(filePath, repoRoot);
  return allSymbols
    .filter((s) => s.startLine >= startLine && s.startLine <= endLine)
    .map((s) => verbatimLine(lines, s.startLine))
    .filter((l): l is string => l !== null);
}

/**
 * Get AST-based signature entries: the verbatim first line of each symbol
 * in the file, prefixed with a ‹warden› annotation showing the full
 * formatted signature for convenience.
 */
function astSignaturesForFile(
  codeIndex: CodeIndexForPruning,
  filePath: string,
  repoRoot: string,
  lines: string[],
): { verbatim: string; annotationLine: string }[] {
  const allSymbols = codeIndex.getSymbolsForFile(filePath, repoRoot);
  const result: { verbatim: string; annotationLine: string }[] = [];
  for (const sym of allSymbols) {
    const vline = verbatimLine(lines, sym.startLine);
    if (vline === null) continue;
    const parts: string[] = [];
    if (sym.exported) parts.push("export");
    if (sym.isAsync) parts.push("async");
    parts.push(sym.kind);
    const name = sym.className ? `${sym.className}.${sym.name}` : sym.name;
    const params = sym.params.length > 0 ? `(${sym.params.join(", ")})` : "()";
    const formatted = `${parts.join(" ")} ${name}${params}`;
    result.push({
      verbatim: vline,
      annotationLine: annotation(`signature: ${formatted}`),
    });
  }
  return result;
}

function findRelevanceRange(
  lines: string[],
  task: TaskContext,
): { start: number; end: number } | null {
  const hint = (task.relevanceHint ?? "").toLowerCase();
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

/** Filter to import lines (verbatim). */
function importLines(lines: string[]): string[] {
  return lines.filter((l) => IMPORT_RE.test(l));
}

export const fileReadModule: PruneModule = {
  toolType: "file-read",
  ruleId: "fileread.slice-outline.v1",
  name: "file-read slice + outline",
  prune(raw: string, task: TaskContext, opts: PruneOptions): PruneResult {
    const threshold = opts.fileReadLargeThresholdLines ?? 400;
    const tokensFull = approxTokens(raw);
    const lines = raw.split(/\r?\n/);
    const mode = opts.readMode ?? "auto";

    // Check if we can use AST-based outlines
    const hasAstIndex =
      opts.codeIndex &&
      opts.filePath &&
      opts.repoRoot &&
      opts.codeIndex.hasIndex(opts.repoRoot);

    // --- Mode: full — return raw unchanged ---
    if (mode === "full") {
      return {
        toolType: "file-read",
        prunedOutput: raw,
        removed: {
          summary: "full mode — returned raw content unchanged",
          tokensRemoved: 0,
          counts: { lines: lines.length },
        },
        tokensFull,
        tokensPruned: tokensFull,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    // --- Mode: imports — return only import lines (verbatim) ---
    if (mode === "imports") {
      const imports = importLines(lines);
      if (imports.length === 0) {
        return {
          toolType: "file-read",
          prunedOutput: raw,
          removed: {
            summary: "no import statements found, returned raw",
            tokensRemoved: 0,
            counts: { lines: lines.length, imports: 0 },
          },
          tokensFull,
          tokensPruned: tokensFull,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }
      const prunedOutput = [
        annotation(`${imports.length} import statements (verbatim):`),
        ...imports,
      ].join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      return {
        toolType: "file-read",
        prunedOutput,
        removed: {
          summary: `imports mode — kept ${imports.length} import lines, omitted ${lines.length - imports.length} non-import lines`,
          tokensRemoved: tokensFull - tokensPruned,
          counts: { lines: lines.length, kept: imports.length, imports: imports.length },
        },
        tokensFull,
        tokensPruned,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    // --- Mode: outline — only structural header lines (verbatim) ---
    if (mode === "outline") {
      let headers: string[];
      let outlineSource: "ast" | "regex";

      if (hasAstIndex && opts.filePath && opts.repoRoot) {
        // AST-based: use verbatim first lines of each symbol
        headers = astOutlineForRange(
          opts.codeIndex!,
          opts.filePath,
          opts.repoRoot,
          1,
          lines.length,
          lines,
        );
        outlineSource = "ast";
      } else {
        // Regex-based: filter to structural header lines
        headers = outline(lines);
        outlineSource = "regex";
      }

      if (headers.length === 0) {
        return {
          toolType: "file-read",
          prunedOutput: raw,
          removed: {
            summary: "outline mode — no structural headers found, returned raw",
            tokensRemoved: 0,
            counts: { lines: lines.length, headers: 0 },
          },
          tokensFull,
          tokensPruned: tokensFull,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      const prunedOutput = [
        annotation(`outline mode — ${headers.length} ${outlineSource === "ast" ? "AST symbol" : "structural header"} lines (verbatim):`),
        ...headers,
      ].join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      return {
        toolType: "file-read",
        prunedOutput,
        removed: {
          summary: `outline mode — kept ${headers.length} header lines (${outlineSource}), omitted ${lines.length - headers.length} body lines`,
          tokensRemoved: tokensFull - tokensPruned,
          counts: { lines: lines.length, kept: headers.length, headers: headers.length, astOutline: outlineSource === "ast" ? 1 : 0 },
        },
        tokensFull,
        tokensPruned,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    // --- Mode: signatures — verbatim first line of each AST symbol + annotation ---
    if (mode === "signatures") {
      if (!hasAstIndex || !opts.filePath || !opts.repoRoot) {
        // No AST index — fall back to outline mode
        const headers = outline(lines);
        if (headers.length === 0) {
          return {
            toolType: "file-read",
            prunedOutput: raw,
            removed: {
              summary: "signatures mode — no AST index and no headers found, returned raw",
              tokensRemoved: 0,
              counts: { lines: lines.length },
            },
            tokensFull,
            tokensPruned: tokensFull,
            ruleId: fileReadModule.ruleId,
            guardOk: true,
          };
        }
        const prunedOutput = [
          annotation(`signatures mode — no AST index, ${headers.length} regex headers (verbatim):`),
          ...headers,
        ].join("\n");
        const tokensPruned = approxTokens(prunedOutput);
        return {
          toolType: "file-read",
          prunedOutput,
          removed: {
            summary: `signatures mode — no AST index, kept ${headers.length} header lines (regex fallback)`,
            tokensRemoved: tokensFull - tokensPruned,
            counts: { lines: lines.length, kept: headers.length, fallback: 1 },
          },
          tokensFull,
          tokensPruned,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      const sigs = astSignaturesForFile(
        opts.codeIndex!,
        opts.filePath,
        opts.repoRoot,
        lines,
      );

      if (sigs.length === 0) {
        return {
          toolType: "file-read",
          prunedOutput: raw,
          removed: {
            summary: "signatures mode — no AST symbols found, returned raw",
            tokensRemoved: 0,
            counts: { lines: lines.length },
          },
          tokensFull,
          tokensPruned: tokensFull,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      // Interleave: annotation (formatted signature) + verbatim line
      const outputLines: string[] = [
        annotation(`signatures mode — ${sigs.length} symbols (verbatim lines + formatted annotations):`),
      ];
      for (const sig of sigs) {
        outputLines.push(sig.annotationLine);
        outputLines.push(sig.verbatim);
      }
      const prunedOutput = outputLines.join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      return {
        toolType: "file-read",
        prunedOutput,
        removed: {
          summary: `signatures mode — kept ${sigs.length} symbol declaration lines (verbatim) with formatted annotations, omitted ${lines.length - sigs.length} body lines`,
          tokensRemoved: tokensFull - tokensPruned,
          counts: { lines: lines.length, kept: sigs.length, symbols: sigs.length },
        },
        tokensFull,
        tokensPruned,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    // --- Mode: symbol — one specific symbol by name + its full body ---
    if (mode === "symbol") {
      const symbolName = opts.symbolName;
      if (!symbolName) {
        return {
          toolType: "file-read",
          prunedOutput: raw,
          removed: {
            summary: "symbol mode — no symbolName provided, returned raw",
            tokensRemoved: 0,
            counts: { lines: lines.length },
          },
          tokensFull,
          tokensPruned: tokensFull,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      if (!hasAstIndex || !opts.filePath || !opts.repoRoot) {
        // No AST index — try regex: find the header line matching the symbol name
        const headerIdx = lines.findIndex(
          (l) => HEADER_RE.test(l) && l.includes(symbolName),
        );
        if (headerIdx < 0) {
          return {
            toolType: "file-read",
            prunedOutput: raw,
            removed: {
              summary: `symbol mode — symbol "${symbolName}" not found (no AST index, regex fallback), returned raw`,
              tokensRemoved: 0,
              counts: { lines: lines.length },
            },
            tokensFull,
            tokensPruned: tokensFull,
            ruleId: fileReadModule.ruleId,
            guardOk: true,
          };
        }
        // Find the end of the block: next header at same or lesser indentation
        const indent = lines[headerIdx]!.match(/^\s*/)?.[0].length ?? 0;
        let endIdx = headerIdx;
        for (let j = headerIdx + 1; j < lines.length; j++) {
          const line = lines[j]!;
          if (HEADER_RE.test(line)) {
            const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
            if (lineIndent <= indent) break;
          }
          endIdx = j;
        }
        const slice = lines.slice(headerIdx, endIdx + 1);
        const prunedOutput = [
          annotation(`symbol mode — "${symbolName}" (${slice.length} lines, regex fallback):`),
          ...slice,
        ].join("\n");
        const tokensPruned = approxTokens(prunedOutput);
        return {
          toolType: "file-read",
          prunedOutput,
          removed: {
            summary: `symbol mode — kept ${slice.length} lines for "${symbolName}" (regex fallback), omitted ${lines.length - slice.length} lines`,
            tokensRemoved: tokensFull - tokensPruned,
            counts: { lines: lines.length, kept: slice.length, fallback: 1 },
          },
          tokensFull,
          tokensPruned,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      // AST-based: find the symbol in the code index
      const allSymbols = opts.codeIndex!.getSymbolsForFile(opts.filePath, opts.repoRoot);
      const sym = allSymbols.find(
        (s) => s.name === symbolName || (s.className && `${s.className}.${s.name}` === symbolName),
      );
      if (!sym) {
        return {
          toolType: "file-read",
          prunedOutput: raw,
          removed: {
            summary: `symbol mode — symbol "${symbolName}" not found in AST index, returned raw`,
            tokensRemoved: 0,
            counts: { lines: lines.length },
          },
          tokensFull,
          tokensPruned: tokensFull,
          ruleId: fileReadModule.ruleId,
          guardOk: true,
        };
      }

      // Slice the symbol's line range (1-based in index, 0-based in array)
      const startIdx = sym.startLine - 1;
      const endIdx = sym.endLine;
      const slice = lines.slice(startIdx, endIdx);
      const prunedOutput = [
        annotation(`symbol mode — "${symbolName}" (${sym.kind}, lines ${sym.startLine}-${sym.endLine}, ${slice.length} lines verbatim):`),
        ...slice,
      ].join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      return {
        toolType: "file-read",
        prunedOutput,
        removed: {
          summary: `symbol mode — kept ${slice.length} lines for "${symbolName}" (${sym.kind}), omitted ${lines.length - slice.length} lines`,
          tokensRemoved: tokensFull - tokensPruned,
          counts: { lines: lines.length, kept: slice.length, symbolFound: 1 },
        },
        tokensFull,
        tokensPruned,
        ruleId: fileReadModule.ruleId,
        guardOk: true,
      };
    }

    // --- Mode: auto (default) — current behavior ---
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
    // AST outlines now use VERBATIM file lines (not synthetic signatures)
    let olBefore: string[];
    let olAfter: string[];
    let outlineSource: "ast" | "regex";

    if (hasAstIndex && opts.filePath && opts.repoRoot) {
      // AST-based outlines: use verbatim first lines of symbols
      const beforeStart = 1;
      const beforeEnd = range.start + 1; // range.start is 0-based, convert to 1-based
      const afterStart = range.end + 2; // 1-based line after the slice
      const afterEnd = lines.length;

      olBefore = astOutlineForRange(
        opts.codeIndex!,
        opts.filePath,
        opts.repoRoot,
        beforeStart,
        beforeEnd,
        lines,
      );
      olAfter = astOutlineForRange(
        opts.codeIndex!,
        opts.filePath,
        opts.repoRoot,
        afterStart,
        afterEnd,
        lines,
      );
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
              `… ${before.length} lines before relevance; ${olBefore.length} ${outlineSource === "ast" ? "symbol declarations" : "headers"}:`,
            ),
            ...olBefore.slice(0, 30),
          ]
        : []),
      ...slice,
      ...(olAfter.length > 0
        ? [
            annotation(
              `… ${after.length} lines after relevance; ${olAfter.length} ${outlineSource === "ast" ? "symbol declarations" : "headers"}:`,
            ),
            ...olAfter.slice(0, 30),
          ]
        : []),
    ].join("\n");

    const tokensPruned = approxTokens(prunedOutput);
    const removed: RemovedSummary = {
      summary: `Large file (${lines.length} lines); kept ${slice.length} relevant lines verbatim, replaced the rest with ${outlineSource === "ast" ? "AST symbol declarations" : "structural outlines"}.`,
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

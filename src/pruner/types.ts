/**
 * Pruning engine type contracts.
 *
 * The non-negotiable trust rule (enforced by the framework, not per-module):
 * code blocks, shell commands, and error/stack-trace text are never rewritten
 * or paraphrased — only included or excluded wholesale. The framework's guard
 * verifies this by asserting every non-decorative line in the pruned output
 * appears verbatim in the raw input (line-level inclusion invariant).
 */
import type { TaskContext } from "../classifier/types.js";

/** Coarse tool-type keys used to select a pruning module. */
export type ToolType =
  | "grep"
  | "search"
  | "file-read"
  | "test-log"
  | "web-fetch"
  | "json"
  | "generic";

export interface PruneInput {
  toolType: ToolType;
  rawOutput: string;
  task: TaskContext;
  /** Optional per-call overrides (e.g. max lines). */
  options?: PruneOptions;
}

export interface PruneOptions {
  fileReadLargeThresholdLines?: number;
  grepMaxMatches?: number;
  testLogFailureContextLines?: number;
  /**
   * Optional code index for AST-based file outlines. When provided, the
   * fileread module uses tree-sitter-parsed symbols instead of regex-based
   * header detection — giving richer, more precise outlines with parameter
   * lists and export status.
   */
  codeIndex?: CodeIndexForPruning;
  /** File path being pruned (needed to look up symbols in the code index). */
  filePath?: string;
  /** Repo root (needed to resolve relative paths for code index lookups). */
  repoRoot?: string;
}

/**
 * Minimal code index interface for the fileread pruner.
 * Returns symbol signatures for a file path.
 */
export interface CodeIndexForPruning {
  getSymbolsForFile(
    filePath: string,
    repoRoot: string,
  ): Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    params: string[];
    exported: boolean;
    isAsync: boolean;
    className: string | null;
  }>;
  hasIndex(repoRoot: string): boolean;
}

export interface RemovedSummary {
  /** Human-readable description of what was cut and why. */
  summary: string;
  /** Approximate token count removed (rough: 4 chars/token). */
  tokensRemoved: number;
  /** Counts of structural items collapsed/removed. */
  counts: Record<string, number>;
}

export interface PruneResult {
  /** The tool type the engine selected a module for. */
  toolType: ToolType;
  /** Pruned output ready to send to the model. */
  prunedOutput: string;
  /** What was removed — required, powers the eval diff + transparency report. */
  removed: RemovedSummary;
  /** Approximate tokens in the raw output. */
  tokensFull: number;
  /** Approximate tokens in the pruned output. */
  tokensPruned: number;
  /** The rule id that produced this result (for eval-gate tracking). */
  ruleId: string;
  /** Whether the guard's inclusion invariant held. Always true on success. */
  guardOk: boolean;
}

export interface PruneModule {
  /** Tool type this module handles. */
  readonly toolType: ToolType;
  /** Stable rule id — used as the eval-gate key. */
  readonly ruleId: string;
  /** Human-readable name shown in `warden status`. */
  readonly name: string;
  /** Prune the raw output. Must only REMOVE content, never rewrite it. */
  prune(
    rawOutput: string,
    task: TaskContext,
    options: PruneOptions,
  ): PruneResult;
}

/** Rough token estimate (~4 chars/token). Good enough for relative comparison. */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

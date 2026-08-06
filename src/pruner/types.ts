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
  /**
   * Prune the raw output. Must only REMOVE content, never rewrite it.
   *
   * Contract: every non-annotation line in the returned prunedOutput must
   * appear verbatim in the raw input, including leading whitespace. The
   * guard checks this with trimEnd() only — leading whitespace is
   * semantically meaningful (code indentation) and must be preserved.
   * Modules that alter indentation will fail the guard and fall back to raw.
   */
  prune(
    rawOutput: string,
    task: TaskContext,
    options: PruneOptions,
  ): PruneResult;
}

/**
 * Structured metadata returned with every pruned tool output.
 * Agents can use this to render badges, tooltips, and detail panels.
 * Privacy-safe: contains only token counts, rule IDs, and summaries —
 * never raw code content.
 */
export interface WardenMeta {
  /** Rule that handled this call (e.g. "grep.relevance-collapse.v1"). */
  ruleId: string;
  /** Human-readable rule name (e.g. "grep relevance collapse"). */
  ruleName?: string;
  /** Lifecycle stage of the rule. */
  stage: "shadow" | "canary" | "active" | "reverted";
  /** Whether pruning was applied (true) or observed in shadow (false). */
  applied: boolean;
  /** Whether the trust guard verified the pruned output. */
  guardOk: boolean;
  /** Token count of the raw output. */
  tokensFull: number;
  /** Token count of the shipped (pruned) output. */
  tokensPruned: number;
  /** Tokens saved (tokensFull - tokensPruned, 0 if guardOk is false). */
  tokensSaved: number;
  /** Human-readable summary of what was removed. */
  removedSummary: string;
  /** Preprocessing stages applied (e.g. ["ansi-strip", "path-shorten"]). */
  preprocStages?: string[];
  /** CCR retrieval hash if the original was stored, null otherwise. */
  ccrHash?: string | null;
  /** ISO timestamp of the prune call. */
  timestamp?: string;
}

/**
 * Build a WardenMeta object from a PruneResult and context.
 * Centralizes metadata construction so all output paths (MCP, CLI) are consistent.
 */
export function buildWardenMeta(opts: {
  result: PruneResult;
  stage: "shadow" | "canary" | "active" | "reverted";
  applied: boolean;
  preprocStages?: string[];
  ccrHash?: string | null;
}): WardenMeta {
  const { result, stage, applied, preprocStages, ccrHash } = opts;
  const tokensSaved = applied && result.guardOk
    ? Math.max(0, result.tokensFull - result.tokensPruned)
    : 0;
  return {
    ruleId: result.ruleId,
    stage,
    applied,
    guardOk: result.guardOk,
    tokensFull: result.tokensFull,
    tokensPruned: result.tokensPruned,
    tokensSaved,
    removedSummary: result.removed.summary,
    preprocStages,
    ccrHash: ccrHash ?? null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format the standardized inline annotation line.
 * Compact, human-friendly, scannable:
 *   ‹warden› saved=4295 (79%) rule=grep.relevance-collapse.v1 stage=active applied=true guardOk=true
 */
export function formatWardenAnnotation(meta: WardenMeta): string {
  const pct = meta.tokensFull > 0
    ? Math.round((meta.tokensSaved / meta.tokensFull) * 100)
    : 0;
  const parts = [
    `saved=${meta.tokensSaved} (${pct}%)`,
    `rule=${meta.ruleId}`,
    `stage=${meta.stage}`,
    `applied=${meta.applied}`,
    `guardOk=${meta.guardOk}`,
  ];
  if (meta.ccrHash) {
    parts.push(`ccr=${meta.ccrHash}`);
  }
  return `‹warden› ${parts.join(" ")}`;
}

/**
 * Format a visual badge line with emoji icons, designed to be visible at a
 * glance even in collapsed tool output. Prepended to the TOP of pruned output
 * so it's the first thing the user sees.
 *
 * Format:
 *   ⚡ Warden │ 7,182 tokens saved (94%) │ 🛡️ guard verified │ 📋 fileread.slice-outline.v1
 *
 * Or when no savings (passthrough):
 *   ⚡ Warden │ passthrough (under threshold) │ 🛡️ guard verified
 */
export function formatWardenBadge(meta: WardenMeta): string {
  const pct = meta.tokensFull > 0
    ? Math.round((meta.tokensSaved / meta.tokensFull) * 100)
    : 0;
  const guardIcon = meta.guardOk ? "🛡️ guard ✓" : "🛡️ guard ✗";
  const parts: string[] = [];

  if (meta.tokensSaved > 0) {
    parts.push(`⚡ ${meta.tokensSaved.toLocaleString()} tokens saved (${pct}%)`);
  } else if (meta.applied) {
    parts.push("⚡ passthrough (under threshold)");
  } else {
    parts.push(`⚡ shadow mode (observing)`);
  }

  parts.push(guardIcon);
  parts.push(`📋 ${meta.ruleId}`);

  return `‹warden› ${parts.join(" │ ")}`;
}

/**
 * Format the cumulative savings line with a chart icon.
 *   📊 Warden cumulative │ 48,608 tokens saved this project
 */
export function formatWardenCumulative(totalSaved: number): string {
  return `‹warden› 📊 cumulative │ ${totalSaved.toLocaleString()} tokens saved this project`;
}

/**
 * Format the CCR retrieval hint with a search icon.
 *   🔍 Warden CCR │ warden_retrieve("745052e18208") or warden_retrieve("745052e18208", around="symbolName")
 */
export function formatWardenCcr(ccrHash: string): string {
  return `‹warden› 🔍 retrieve │ warden_retrieve("${ccrHash}") or warden_retrieve("${ccrHash}", around="symbolName") or warden_retrieve("${ccrHash}", lines="120:170")`;
}

/**
 * Format the warden_meta as a JSON block for agents that can parse structured data.
 * Delimited clearly so text-only agents show it as a compact block.
 */
export function formatWardenMetaJson(meta: WardenMeta): string {
  return `‹warden_meta› ${JSON.stringify(meta)}`;
}

/** Rough token estimate (~4 chars/token). Good enough for relative comparison. */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

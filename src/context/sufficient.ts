/**
 * P4 — Unified minimal sufficient context.
 *
 * Wraps `selectContext` (Layer 1) with the other layers built in P0-P3:
 *   - Memory recall (P1): past decisions relevant to the task
 *   - Failed approach warning (P1): past failures for similar tasks
 *   - Git context (P3): churn metrics for top files
 *   - Token budget (new): optional budget-aware trimming
 *   - Minimum sufficient stopping (new): stop when budget is reached
 *
 * Design principle: DON'T rewrite selectContext. Wrap it. The existing
 * function stays unchanged for backward compat. This module adds the
 * integration layer that combines all context sources into a single
 * "here's everything you need" response.
 *
 * The result is a single object the agent can use to start a task with
 * minimal sufficient context — not just file recommendations, but also
 * past decisions, warnings about failed approaches, and volatility signals.
 */
import { selectContext, type ContextSelectionResult, type ContextFile } from "../context/index.js";
import { approxTokens } from "../pruner/types.js";
import type { AgentMemory, MemoryResult } from "../memory/index.js";
import { gitChangeFrequency, type GitChangeFrequency } from "../git/context.js";

/** Context category — why this file is in the package. */
export type ContextCategory = "direct" | "dependency" | "test" | "config" | "doc";

/** A file enriched with category, git churn, and budget tracking. */
export interface SufficientContextFile extends ContextFile {
  category: ContextCategory;
  gitChurn?: GitChangeFrequency;
  tokens: number;
}

/** A memory relevant to the task, with type annotation. */
export interface RelevantMemory {
  type: "decision" | "warning" | "failed_approach";
  memory: MemoryResult;
}

/** The unified context result — everything the agent needs to start a task. */
export interface SufficientContextResult {
  task: string;

  /** File recommendations enriched with categories, git churn, token counts. */
  files: SufficientContextFile[];

  /** Past decisions relevant to this task. */
  memories: RelevantMemory[];

  /** Failed approaches that should be avoided. */
  failedApproaches: MemoryResult[];

  /** Git volatility summary for the top files. */
  volatilityNotes: string[];

  /** Token accounting. */
  tokensBudget: number | null;
  tokensUsed: number;
  tokensFull: number;
  reductionPct: number;

  /** Whether the package was trimmed to fit a budget. */
  trimmed: boolean;

  /** Human-readable reasoning. */
  reasoning: string;

  /** The original selectContext result (for backward compat). */
  base: ContextSelectionResult;
}

/** Subset of AgentMemory needed for sufficient context. */
export interface MemoryProvider {
  recall(query: string, limit?: number): MemoryResult[];
  findFailedApproaches(query: string, limit?: number): MemoryResult[];
}

/** Subset of git context needed. */
export interface GitProvider {
  gitChangeFrequency(repoRoot: string, filePath: string): GitChangeFrequency;
}

/**
 * Build a unified minimal sufficient context package for a task.
 *
 * This is the P4 integration layer. It:
 *   1. Calls selectContext for file recommendations + compact package
 *   2. Recalls past decisions relevant to the task
 *   3. Finds failed approaches that should be avoided
 *   4. Enriches top files with git churn metrics
 *   5. Categorizes files (direct, dependency, test, config, doc)
 *   6. If tokenBudget is set, trims the package to fit
 *
 * @param opts.task - Task description
 * @param opts.repoRoot - Repository root
 * @param opts.maxFiles - Max files (default 15, passed to selectContext)
 * @param opts.tokenBudget - Optional token budget. When set, trims package to fit.
 * @param opts.store - Optional ContextStore for selectContext
 * @param opts.codeIndex - Optional CodeIndexStore for selectContext
 * @param opts.memory - Optional MemoryProvider for recall + failed approaches
 * @param opts.git - Optional GitProvider for churn metrics
 * @param opts.memoryLimit - Max memories to recall (default 5)
 * @param opts.failedApproachLimit - Max failed approaches to surface (default 3)
 */
export async function sufficientContext(opts: {
  task: string;
  repoRoot: string;
  maxFiles?: number;
  tokenBudget?: number;
  store?: Parameters<typeof selectContext>[0]["store"];
  codeIndex?: Parameters<typeof selectContext>[0]["codeIndex"];
  memory?: MemoryProvider;
  git?: GitProvider;
  memoryLimit?: number;
  failedApproachLimit?: number;
}): Promise<SufficientContextResult> {
  const memoryLimit = opts.memoryLimit ?? 5;
  const failedApproachLimit = opts.failedApproachLimit ?? 3;

  // 1. Get base file recommendations from selectContext
  const base = await selectContext({
    task: opts.task,
    repoRoot: opts.repoRoot,
    maxFiles: opts.maxFiles,
    store: opts.store,
    codeIndex: opts.codeIndex,
  });

  // 2. Recall past decisions (if memory provider available)
  let memories: RelevantMemory[] = [];
  if (opts.memory) {
    const recalled = opts.memory.recall(opts.task, memoryLimit);
    memories = recalled.map((m) => ({
      type: "decision" as const,
      memory: m,
    }));
  }

  // 3. Find failed approaches (if memory provider available)
  let failedApproaches: MemoryResult[] = [];
  if (opts.memory) {
    failedApproaches = opts.memory.findFailedApproaches(
      opts.task,
      failedApproachLimit,
    );
  }

  // 4. Enrich files with categories, git churn, and token counts
  const files: SufficientContextFile[] = base.package.map((f) => {
    const category = categorizeFile(f.filePath, f.reason);
    const tokens = approxTokens(
      f.slices.map((s) => s.code).join("\n") +
        f.outline.map((o) => o.header).join("\n"),
    );

    let gitChurn: GitChangeFrequency | undefined;
    if (opts.git) {
      try {
        gitChurn = opts.git.gitChangeFrequency(opts.repoRoot, f.filePath);
      } catch {
        // File might not be tracked — skip
      }
    }

    return {
      ...f,
      category,
      gitChurn,
      tokens,
    };
  });

  // 5. Token budget trimming
  const tokensBudget = opts.tokenBudget ?? null;
  let tokensUsed = files.reduce((sum, f) => sum + f.tokens, 0);
  let trimmed = false;

  if (tokensBudget !== null && tokensUsed > tokensBudget) {
    // Sort by relevance (highest first) — keep most relevant until budget hit
    const sorted = [...files].sort((a, b) => b.relevance - a.relevance);
    const kept: SufficientContextFile[] = [];
    let runningTokens = 0;

    for (const f of sorted) {
      if (runningTokens + f.tokens > tokensBudget) {
        // Can't fit this file — skip it
        trimmed = true;
        continue;
      }
      kept.push(f);
      runningTokens += f.tokens;
    }

    // Re-sort kept files by original order (by relevance from base)
    const keptPaths = new Set(kept.map((f) => f.filePath));
    files.length = 0;
    files.push(...base.package
      .map((f) => enrichedById(files, f.filePath))
      .filter((f): f is SufficientContextFile => f !== null && keptPaths.has(f.filePath))
    );

    tokensUsed = runningTokens;
  }

  // 6. Volatility notes from git churn
  const volatilityNotes: string[] = [];
  for (const f of files) {
    if (f.gitChurn && f.gitChurn.totalCommits > 5) {
      volatilityNotes.push(
        `${f.filePath}: ${f.gitChurn.totalCommits} commits, churn ${f.gitChurn.churnScore} lines/commit — volatile file, expect recent changes`,
      );
    }
  }

  // 7. Build reasoning
  const reasoningParts: string[] = [base.reasoning];
  if (memories.length > 0) {
    reasoningParts.push(
      `${memories.length} past decision(s) recalled for this task.`,
    );
  }
  if (failedApproaches.length > 0) {
    reasoningParts.push(
      `WARNING: ${failedApproaches.length} failed approach(es) found — check before proceeding.`,
    );
  }
  if (volatilityNotes.length > 0) {
    reasoningParts.push(
      `${volatilityNotes.length} volatile file(s) detected (high git churn).`,
    );
  }
  if (trimmed) {
    reasoningParts.push(
      `Package trimmed to fit ${tokensBudget} token budget (${tokensUsed} tokens used).`,
    );
  }

  const reductionPct =
    base.tokensFull > 0
      ? Math.round(((base.tokensFull - tokensUsed) / base.tokensFull) * 1000) / 10
      : 0;

  return {
    task: opts.task,
    files,
    memories,
    failedApproaches,
    volatilityNotes,
    tokensBudget,
    tokensUsed,
    tokensFull: base.tokensFull,
    reductionPct,
    trimmed,
    reasoning: reasoningParts.join(" "),
    base,
  };
}

/**
 * Categorize a file based on its path and selection reason.
 */
function categorizeFile(filePath: string, reason: string): ContextCategory {
  const lower = filePath.toLowerCase();
  const lowerReason = reason.toLowerCase();

  if (lower.includes(".test.") || lower.includes(".spec.") || lower.includes("/test/") || lower.includes("/tests/")) {
    return "test";
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".rst")) {
    return "doc";
  }
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".toml") || lower.endsWith(".env") || lower.endsWith(".config.") || lower.includes(".config/")) {
    return "config";
  }
  if (lowerReason.includes("import") || lowerReason.includes("dependency") || lowerReason.includes("symbol")) {
    return "dependency";
  }
  return "direct";
}

/**
 * Find an enriched file by path (helper for budget trimming).
 */
function enrichedById(files: SufficientContextFile[], filePath: string): SufficientContextFile | null {
  return files.find((f) => f.filePath === filePath) ?? null;
}

/**
 * Format the sufficient context result as human-readable text.
 */
export function formatSufficientContext(result: SufficientContextResult): string {
  const lines: string[] = [
    `SUFFICIENT CONTEXT — ${result.task}`,
    "",
  ];

  // Files
  if (result.files.length > 0) {
    lines.push(`FILES (${result.files.length})`);
    for (const f of result.files) {
      const churn = f.gitChurn
        ? ` | churn=${f.gitChurn.churnScore} (${f.gitChurn.totalCommits} commits)`
        : "";
      lines.push(
        `  [${f.category.toUpperCase().padEnd(11)}] ${f.filePath} (${f.tokens} tokens, ${f.linesIncluded}/${f.totalLines} lines)${churn}`,
      );
      for (const s of f.slices.slice(0, 2)) {
        lines.push(`    L${s.startLine}-${s.endLine}: ${s.reason}`);
      }
      if (f.slices.length > 2) {
        lines.push(`    ... +${f.slices.length - 2} more slices`);
      }
    }
    lines.push("");
  }

  // Memories
  if (result.memories.length > 0) {
    lines.push(`PAST DECISIONS (${result.memories.length})`);
    for (const m of result.memories) {
      lines.push(
        `  [${m.memory.category}] ${m.memory.title}`,
      );
      lines.push(`    ${m.memory.body.slice(0, 120)}${m.memory.body.length > 120 ? "..." : ""}`);
      if (m.memory.scope) lines.push(`    scope: ${m.memory.scope}`);
    }
    lines.push("");
  }

  // Failed approaches
  if (result.failedApproaches.length > 0) {
    lines.push("FAILED APPROACHES — DO NOT REPEAT");
    for (const f of result.failedApproaches) {
      lines.push(`  WARNING: ${f.title}`);
      lines.push(`    ${f.body.slice(0, 120)}${f.body.length > 120 ? "..." : ""}`);
      if (f.evidence.length > 0) {
        lines.push(`    evidence: ${f.evidence.join(", ")}`);
      }
    }
    lines.push("");
  }

  // Volatility
  if (result.volatilityNotes.length > 0) {
    lines.push("VOLATILITY NOTES");
    for (const note of result.volatilityNotes) {
      lines.push(`  ${note}`);
    }
    lines.push("");
  }

  // Token accounting
  lines.push("TOKEN ACCOUNTING");
  lines.push(`  Full files:     ${result.tokensFull.toLocaleString()} tokens`);
  lines.push(`  Used:           ${result.tokensUsed.toLocaleString()} tokens`);
  if (result.tokensBudget !== null) {
    lines.push(`  Budget:         ${result.tokensBudget.toLocaleString()} tokens`);
    lines.push(`  Trimmed:        ${result.trimmed ? "yes" : "no"}`);
  }
  lines.push(`  Reduction:      ${result.reductionPct}%`);
  lines.push("");

  return lines.join("\n");
}

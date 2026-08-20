/**
 * Warden orchestrator — wires the classifier, pruning engine, eval gate, and
 * local store into one cohesive pipeline. Used by both the MCP server and the
 * CLI so they share identical behavior.
 *
 * Pipeline per tool call:
 *   classify task → prune output → guard check →
 *   if rule is active: ship pruned, record prune decision
 *   if rule is shadow: ship raw (safe), record shadow evidence + observe decision
 */
import {
  TaskClassifier,
  type ClassifyInput,
  type TaskContext,
} from "./classifier/index.js";
import { existsSync } from "node:fs";
import {
  PruningEngine,
  type PruneResult,
  type ToolType,
} from "./pruner/index.js";
import { EvalGate } from "./eval/index.js";
import { SqliteStore, type RuleStage } from "./store/sqlite.js";
import {
  configForRisk,
  DEFAULT_CONFIG,
  type WardenConfig,
  ensureWardenDir,
  dbPath,
  findRepoRoot,
} from "./config/index.js";
import { logger } from "./logging/index.js";
import { registeredModules } from "./pruner/index.js";
import { AgentMemory } from "./memory/index.js";
import { TaskTracker } from "./eval/outcomes.js";
import { registerProject } from "./stats/global.js";
import { recordSpend } from "./budget/index.js";
import { storeOriginal, appendCcrMarker } from "./ccr/index.js";

export interface PruneCallInput {
  toolType: ToolType;
  rawOutput: string;
  userMessage?: string;
  recentTurns?: string[];
  toolName?: string | null;
  /** Override the classifier (skip LLM) for speed. */
  taskHint?: string;
  /** Optional per-call pruning overrides (e.g. code index for AST outlines). */
  pruneOptions?: import("./pruner/types.js").PruneOptions;
}

export interface PruneCallResult {
  result: PruneResult;
  task: TaskContext;
  /** What actually got sent to the model (pruned if active, raw if shadow). */
  shipped: string;
  /** Stage of the rule that handled this call. */
  stage: RuleStage;
  /** Whether pruning was applied (true) or observed in shadow (false). */
  applied: boolean;
}

export class Warden {
  readonly store: SqliteStore;
  readonly config: WardenConfig;
  readonly classifier: TaskClassifier;
  readonly engine: PruningEngine;
  readonly gate: EvalGate;
  readonly repoRoot?: string;
  readonly memory: AgentMemory;
  readonly tracker: TaskTracker;

  private constructor(
    store: SqliteStore,
    config: WardenConfig,
    classifier: TaskClassifier,
    repoRoot?: string,
  ) {
    this.store = store;
    this.config = config;
    this.classifier = classifier;
    this.engine = new PruningEngine(this.config);
    this.gate = new EvalGate(this.store, this.config);
    this.repoRoot = repoRoot;
    this.memory = new AgentMemory(store);
    this.tracker = new TaskTracker(store);
    this.ensureRules();
  }

  /** Async factory — SqliteStore.open is async (dynamic node:sqlite import). */
  static async create(opts?: {
    config?: WardenConfig;
    classifier?: TaskClassifier;
    repoRoot?: string;
    dbPath?: string;
  }): Promise<Warden> {
    const repoRoot = opts?.repoRoot ?? findRepoRoot();
    const config = opts?.config ?? configForRisk(DEFAULT_CONFIG.riskTolerance);
    const path = opts?.dbPath ?? dbPath(repoRoot);
    ensureWardenDir(repoRoot);
    const dbExisted = existsSync(path);
    const store = await SqliteStore.open(path);
    const classifier = opts?.classifier ?? new TaskClassifier();
    const warden = new Warden(store, config, classifier, repoRoot);

    // Register this project in the global registry for cross-project stats
    if (repoRoot) {
      registerProject(repoRoot, path);
    }

    // Pre-warm the embedding model in the background so semantic memory
    // search is ready by the first recall(). Non-blocking — if this fails,
    // recall falls back to FTS5. The model downloads once (~22 MB) and
    // caches locally under ~/.warden/models/.
    if (process.env.WARDEN_NO_EMBEDDINGS !== "1" && process.env.WARDEN_NO_EMBEDDINGS !== "true") {
      import("./memory/embeddings.js")
        .then((m) => m.warmEmbeddings())
        .catch(() => { /* non-fatal — FTS5 fallback */ });
    }

    // First-run welcome message (only when the DB was just created)
    if (!dbExisted && process.env.WARDEN_SILENT !== "1") {
      const live = registeredModules().length;
      logger.info("Warden database created — pruning rules active", {
        path,
        rules: live,
      });
      process.stderr.write(
        `\n  Warden initialized — ${live} pruning rules active (saving tokens from first tool call).\n` +
          `  Run \`warden status\` to see savings. Use \`warden revert <rule-id>\` if a rule causes issues.\n\n`,
      );
    }

    return warden;
  }

  /** Register built-in pruning modules; activate by default unless enterprise. */
  private ensureRules(): void {
    const existing = new Set(this.store.listRules().map((r) => r.id));
    const now = new Date().toISOString();
    const stage = this.config.defaultRuleStage;
    for (const mod of registeredModules()) {
      if (existing.has(mod.ruleId)) continue;
      this.store.upsertRule({
        id: mod.ruleId,
        tool_type: mod.toolType,
        name: mod.name,
        stage,
        created_at: now,
        promoted_at: stage === "active" ? now : null,
        reverted_at: null,
        revert_reason: null,
        config_json: "{}",
      });
      logger.info("registered pruning rule", {
        ruleId: mod.ruleId,
        toolType: mod.toolType,
        stage,
      });
    }
    this.activateBuiltInShadowRules();
  }

  /**
   * Upgrade built-in rules still in shadow to active on startup.
   * Fixes existing installs and ensures savings without manual promotion.
   * Skips reverted rules — those were explicitly disabled.
   */
  private activateBuiltInShadowRules(): void {
    if (this.config.defaultRuleStage !== "active") return;
    for (const mod of registeredModules()) {
      const rule = this.store.getRule(mod.ruleId);
      if (!rule || rule.stage !== "shadow") continue;
      this.store.setRuleStage(mod.ruleId, "active");
      this.store.addDecision({
        kind: "promote",
        rule_id: mod.ruleId,
        tool_type: mod.toolType,
        tokens_saved: 0,
        detail_json: JSON.stringify({
          from: "shadow",
          to: "active",
          reason: "default active — built-in rules ship pruned on install",
        }),
      });
      logger.info("activated built-in rule", { ruleId: mod.ruleId });
    }
  }

  close(): void {
    this.store.close();
  }

  /** Full pipeline for one tool call. */
  async pruneCall(input: PruneCallInput): Promise<PruneCallResult> {
    const t0 = performance.now();
    const classifyInput: ClassifyInput = {
      userMessage: input.userMessage ?? input.taskHint ?? "",
      recentTurns: input.recentTurns,
      toolName: input.toolName ?? null,
    };
    const task: TaskContext = input.taskHint
      ? {
          type: "unknown",
          relevanceHint: input.taskHint,
          userMessage: input.userMessage ?? input.taskHint,
          toolName: input.toolName ?? null,
        }
      : await this.classifier.classify(classifyInput);

    const result = this.engine.prune({
      toolType: input.toolType,
      rawOutput: input.rawOutput,
      task,
      options: input.pruneOptions,
    });

    const rule = this.store.getRule(result.ruleId);
    const stage = (rule?.stage ?? "shadow") as RuleStage;
    const applied = stage === "active" || stage === "canary";
    const durationMs = Math.round(performance.now() - t0);

    if (applied) {
      // CCR: store the original output so the agent can retrieve it if needed.
      // Only stores when pruning actually removed content.
      const ccrMarker = storeOriginal({
        store: this.store,
        rawOutput: input.rawOutput,
        toolType: input.toolType,
        ruleId: result.ruleId,
        tokensFull: result.tokensFull,
        tokensPruned: result.tokensPruned,
      });
      // Append the retrieval marker to the pruned output.
      const shipped = ccrMarker
        ? appendCcrMarker(result.prunedOutput, ccrMarker)
        : result.prunedOutput;

      // Ship the pruned output, log the prune decision.
      this.gate.recordPrune(result, true, durationMs);
      // Track token spend for budget caps (fire-and-forget, non-blocking).
      // Errors are logged at warn level (not silently swallowed) because a
      // failing budget tracker could mean budget caps aren't enforced.
      const tokensShipped = result.tokensPruned;
      recordSpend("project:default", tokensShipped).catch(
        (err) =>
          logger.warn(
            "budget recordSpend failed — budget caps may not be enforced",
            { err: String(err) },
          ),
      );
      return {
        result,
        task,
        shipped,
        stage,
        applied: true,
      };
    }

    // Shadow (or reverted): ship preprocessed output (safe rewrites only —
    // ANSI strip, path shorten, JSON clean, whitespace). No line removal.
    // Record shadow evidence so the gate can score the rule and promote it.
    if (stage === "shadow") {
      this.gate.recordShadow(
        result.ruleId,
        result.toolType,
        input.rawOutput,
        result,
        task,
      );
    }
    this.gate.recordPrune(result, false, durationMs);
    // Track token spend even in shadow mode (the tokens still went to the model).
    const tokensShippedRaw = result.tokensFull;
    recordSpend("project:default", tokensShippedRaw).catch(
      (err) =>
        logger.warn(
          "budget recordSpend failed — budget caps may not be enforced",
          { err: String(err) },
        ),
    );
    // Always apply preprocessing (safe rewrites), even in shadow mode.
    const preprocessed = this.engine.preprocessOnly(input.rawOutput);
    return {
      result,
      task,
      shipped: preprocessed.output,
      stage,
      applied: false,
    };
  }

  /** Snapshot of all rules + their confidence, for status/HUD. */
  status(): Array<{
    ruleId: string;
    name: string;
    toolType: ToolType;
    stage: RuleStage;
    confidence: number;
    samples: number;
    decaying: boolean;
    daysSinceLastRun: number | null;
    tokensSaved: number;
    tokensFull: number;
    tokensPruned: number;
    calls: number;
  }> {
    const rules = this.store.listRules();
    return rules.map((r) => {
      const rep = this.gate.confidence(r.id);
      const stats = this.store.ruleStats(r.id);
      return {
        ruleId: r.id,
        name: r.name,
        toolType: r.tool_type as ToolType,
        stage: r.stage as RuleStage,
        confidence: rep?.effectiveConfidence ?? 0,
        samples: rep?.samples ?? 0,
        decaying: rep?.decaying ?? false,
        daysSinceLastRun: rep?.daysSinceLastRun ?? null,
        tokensSaved: stats.saved,
        tokensFull: stats.full,
        tokensPruned: stats.pruned,
        calls: stats.calls,
      };
    });
  }

  totalTokensSaved(): number {
    return this.store.totalTokensSaved();
  }

  totalTokensProcessed(): number {
    return this.store.totalTokensProcessed();
  }
}

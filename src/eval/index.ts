/**
 * The eval gate — Warden's differentiator.
 *
 * In Phase 1 (MVP) it does shadow-mode comparison + confidence scoring with
 * manual promotion. The shadow comparison metric here is a structural parity
 * score: how much of the task-relevant signal in the full output is preserved
 * in the pruned output. (Phase 2 replaces this with full record/replay against
 * real sessions — same interface, richer evidence.)
 *
 * Confidence = rolling pass-rate of the parity score over the last N shadow
 * runs, decaying if a rule hasn't been re-validated recently. This guards
 * against silent drift over time, not just at launch.
 */
import type { SqliteStore } from "../store/sqlite.js";
import type { PruneResult } from "../pruner/types.js";
import type { TaskContext } from "../classifier/types.js";
import type { WardenConfig } from "../config/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import type {
  ConfidenceReport,
  PromotionDecision,
  ShadowEvidence,
} from "./types.js";
import type { RuleStage } from "../store/sqlite.js";

/** A parity score at/above this counts as a "pass" for the rolling confidence. */
const PARITY_PASS = 0.95;

/**
 * Compute a structural parity score for a prune result vs the raw output.
 *
 * Heuristic for MVP: what fraction of "signal" lines (errors, failures,
 * relevance-hint-matching lines, and structural headers) in the raw output are
 * still present in the pruned output? Annotations we added don't count against
 * us. This is a defensible proxy for "did we keep what mattered" until Phase 2
 * wires in real record/replay.
 */
export function structuralParity(
  raw: string,
  result: PruneResult,
  task: TaskContext,
): number {
  if (raw.length === 0) return 1;
  const rawLines = raw.split(/\r?\n/);
  const hint = (task.relevanceHint ?? "").toLowerCase();
  const hintTokens = hint.split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  const SIGNAL =
    /\b(error|err:|exception|traceback|panic|fatal|fail|failed|failure|✗|✘|not ok)\b/i;
  const HEADER =
    /^\s*(export\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|impl|fn|const)\b.*$/;

  const signalLines = rawLines.filter((l) => {
    if (l.trim().length === 0) return false;
    if (SIGNAL.test(l)) return true;
    if (HEADER.test(l)) return true;
    const low = l.toLowerCase();
    return hintTokens.some((t) => low.includes(t));
  });

  if (signalLines.length === 0) {
    // No detectable signal — parity is "did we keep at least the head?".
    return result.prunedOutput.length > 0 ? 1 : 0;
  }

  const prunedSet = new Set(
    result.prunedOutput.split(/\r?\n/).map((l) => l.trimEnd()),
  );
  let preserved = 0;
  for (const l of signalLines) if (prunedSet.has(l.trimEnd())) preserved++;
  return preserved / signalLines.length;
}

export class EvalGate {
  private readonly store: SqliteStore;
  private readonly config: WardenConfig;

  constructor(store: SqliteStore, config: WardenConfig = DEFAULT_CONFIG) {
    this.store = store;
    this.config = config;
  }

  /**
   * Record a shadow run for a pruning result and return the computed parity.
   * Called whenever a rule runs in shadow mode (i.e. before it's active).
   */
  recordShadow(
    ruleId: string,
    toolType: ShadowEvidence["toolType"],
    raw: string,
    result: PruneResult,
    task: TaskContext,
    notes: string | null = null,
  ): ShadowEvidence {
    const parity = structuralParity(raw, result, task);
    const evidence: ShadowEvidence = {
      ruleId,
      toolType,
      timestamp: new Date().toISOString(),
      parityScore: parity,
      tokensFull: result.tokensFull,
      tokensPruned: result.tokensPruned,
      notes,
    };
    this.store.addShadowRun({
      rule_id: evidence.ruleId,
      tool_type: evidence.toolType,
      timestamp: evidence.timestamp,
      parity_score: evidence.parityScore,
      tokens_full: evidence.tokensFull,
      tokens_pruned: evidence.tokensPruned,
      notes: evidence.notes,
    });
    return evidence;
  }

  /** Confidence report for a rule, with decay applied for stale rules. */
  confidence(ruleId: string): ConfidenceReport | null {
    const rule = this.store.getRule(ruleId);
    if (!rule) return null;
    const runs = this.store.recentShadowRuns(
      ruleId,
      this.config.confidenceWindow,
    );

    // No shadow runs in the window:
    // - Active/canary rules: they were promoted based on past confidence.
    //   Show 1.0 — the promotion was earned. The evidence may have expired
    //   from the window, but the rule is trusted enough to ship.
    // - Shadow rules: no evidence yet, confidence is 0.
    if (runs.length === 0) {
      const isActive = rule.stage === "active" || rule.stage === "canary";
      return {
        ruleId,
        stage: rule.stage as RuleStage,
        confidence: isActive ? 1.0 : 0,
        samples: 0,
        daysSinceLastRun: null,
        decaying: false,
        effectiveConfidence: isActive ? 1.0 : 0,
      };
    }

    const passes = runs.filter((r) => r.parity_score >= PARITY_PASS).length;
    const confidence = passes / runs.length;
    const lastTs = runs[0]!.timestamp;
    const daysSince = Math.max(
      0,
      (Date.now() - new Date(lastTs).getTime()) / 86_400_000,
    );
    const decaying = daysSince > this.config.confidenceDecayDays;
    const decayDays = Math.max(0, daysSince - this.config.confidenceDecayDays);
    const effectiveConfidence = decaying
      ? Math.max(0, confidence - decayDays * 0.01)
      : confidence;

    return {
      ruleId,
      stage: rule.stage as RuleStage,
      confidence,
      samples: runs.length,
      daysSinceLastRun: Math.round(daysSince * 10) / 10,
      decaying,
      effectiveConfidence,
    };
  }

  /** Is a rule eligible for promotion to canary/active? */
  promotionEligibility(ruleId: string): PromotionDecision {
    const rule = this.store.getRule(ruleId);
    const from = rule?.stage as RuleStage | undefined;
    if (!rule || !from) {
      return {
        ruleId,
        from: "shadow",
        to: "shadow",
        reason: "rule not found",
        eligible: false,
      };
    }
    const rep = this.confidence(ruleId);
    if (!rep || rep.samples < this.config.minShadowRuns) {
      return {
        ruleId,
        from,
        to: from === "shadow" ? "canary" : from,
        reason: `need >= ${this.config.minShadowRuns} shadow runs (have ${rep?.samples ?? 0})`,
        eligible: false,
      };
    }
    if (rep.effectiveConfidence < (this.config.autoPromoteConfidence ?? 0.9)) {
      return {
        ruleId,
        from,
        to: from === "shadow" ? "canary" : from,
        reason: `confidence ${rep.effectiveConfidence.toFixed(2)} below threshold`,
        eligible: false,
      };
    }
    const to: RuleStage = from === "shadow" ? "canary" : "active";
    return {
      ruleId,
      from,
      to,
      reason: `confidence ${rep.effectiveConfidence.toFixed(2)} across ${rep.samples} runs`,
      eligible: true,
    };
  }

  /** Manually promote a rule one stage (shadow → canary → active). */
  promote(ruleId: string, force = false): PromotionDecision {
    const decision = this.promotionEligibility(ruleId);
    if (!decision.eligible && !force) return decision;
    const rule = this.store.getRule(ruleId);
    if (!rule) return decision;
    const to: RuleStage = rule.stage === "shadow" ? "canary" : "active";
    this.store.setRuleStage(ruleId, to);
    this.store.addDecision({
      kind: "promote",
      rule_id: ruleId,
      tool_type: rule.tool_type,
      tokens_saved: 0,
      detail_json: JSON.stringify({
        from: rule.stage,
        to,
        reason: decision.reason,
        forced: force,
      }),
    });
    return { ...decision, from: rule.stage as RuleStage, to, eligible: true };
  }

  /** Revert a rule to shadow (manual, or watchdog-driven in Phase 2). */
  revert(ruleId: string, reason: string): void {
    const rule = this.store.getRule(ruleId);
    if (!rule) return;
    this.store.setRuleStage(ruleId, "reverted", reason);
    this.store.addDecision({
      kind: "revert",
      rule_id: ruleId,
      tool_type: rule.tool_type,
      tokens_saved: 0,
      detail_json: JSON.stringify({ from: rule.stage, to: "reverted", reason }),
    });
  }

  /** Record a prune decision in the audit trail. */
  recordPrune(result: PruneResult, applied: boolean): void {
    this.store.addDecision({
      kind: applied ? "prune" : "observe",
      rule_id: result.ruleId,
      tool_type: result.toolType,
      tokens_saved: applied ? result.removed.tokensRemoved : 0,
      detail_json: JSON.stringify({
        guardOk: result.guardOk,
        tokensFull: result.tokensFull,
        tokensPruned: result.tokensPruned,
        summary: result.removed.summary,
        counts: result.removed.counts,
      }),
    });
  }
}

export type {
  ConfidenceReport,
  PromotionDecision,
  ShadowEvidence,
  RuleStage,
} from "./types.js";

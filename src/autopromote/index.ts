/**
 * Auto-promotion pipeline — automatically promotes rules that meet
 * configurable confidence and sample thresholds.
 *
 * Licensed feature. Runs after each shadow observation to check if any
 * shadow rules are eligible for promotion. If auto-promotion is enabled
 * (config.autoPromoteConfidence !== null), eligible rules are promoted
 * automatically through the pipeline: shadow → canary → active.
 *
 * The pipeline respects the promotion stages from the blueprint:
 *   record → replay → shadow → canary → active
 * Each stage has its own threshold, and a rule must pass each stage
 * before advancing.
 */
import type { Warden } from "../warden.js";
import type { EvalGate } from "../eval/index.js";
import { logger } from "../logging/index.js";

export interface AutoPromoteResult {
  /** Rules that were promoted. */
  promoted: Array<{
    ruleId: string;
    from: string;
    to: string;
    confidence: number;
    samples: number;
  }>;
  /** Rules that were checked but not yet eligible. */
  pending: Array<{
    ruleId: string;
    stage: string;
    confidence: number;
    samples: number;
    reason: string;
  }>;
  /** Whether auto-promotion is enabled for the current tier. */
  enabled: boolean;
}

/**
 * Check all shadow/canary rules and auto-promote any that meet thresholds.
 * Called after each shadow observation or periodically.
 */
export function runAutoPromote(warden: Warden): AutoPromoteResult {
  const enabled = warden.config.autoPromoteConfidence !== null;

  if (!enabled) {
    return { promoted: [], pending: [], enabled: false };
  }

  const status = warden.status();
  const promoted: AutoPromoteResult["promoted"] = [];
  const pending: AutoPromoteResult["pending"] = [];
  const threshold = warden.config.autoPromoteConfidence ?? 0.9;
  const minRuns = warden.config.minShadowRuns;

  for (const rule of status) {
    if (rule.stage !== "shadow" && rule.stage !== "canary") continue;

    if (rule.samples < minRuns) {
      pending.push({
        ruleId: rule.ruleId,
        stage: rule.stage,
        confidence: rule.confidence,
        samples: rule.samples,
        reason: `need >= ${minRuns} samples (have ${rule.samples})`,
      });
      continue;
    }

    if (rule.confidence < threshold) {
      pending.push({
        ruleId: rule.ruleId,
        stage: rule.stage,
        confidence: rule.confidence,
        samples: rule.samples,
        reason: `confidence ${rule.confidence.toFixed(2)} < ${threshold}`,
      });
      continue;
    }

    // Eligible — promote
    const decision = warden.gate.promote(rule.ruleId, false);
    if (decision.eligible) {
      promoted.push({
        ruleId: rule.ruleId,
        from: decision.from,
        to: decision.to,
        confidence: rule.confidence,
        samples: rule.samples,
      });
      logger.info("auto-promoted rule", {
        ruleId: rule.ruleId,
        from: decision.from,
        to: decision.to,
        confidence: rule.confidence,
      });
    } else {
      pending.push({
        ruleId: rule.ruleId,
        stage: rule.stage,
        confidence: rule.confidence,
        samples: rule.samples,
        reason: decision.reason,
      });
    }
  }

  return { promoted, pending, enabled: true };
}

/**
 * Eval gate type contracts.
 *
 * Lifecycle: shadow → canary → active → (reverted).
 * In Phase 1 MVP, promotion is manual (`warden promote <ruleId>`); the
 * auto-promote threshold exists in config but defaults to null.
 */
import type { ToolType } from "../pruner/types.js";

export type RuleStage = "shadow" | "canary" | "active" | "reverted";

export interface ShadowEvidence {
  ruleId: string;
  toolType: ToolType;
  timestamp: string;
  /** 0..1 — did the pruned version produce equivalent output/actions to the full version? */
  parityScore: number;
  tokensFull: number;
  tokensPruned: number;
  notes: string | null;
}

export interface ConfidenceReport {
  ruleId: string;
  stage: RuleStage;
  /** Rolling pass-rate over the last N shadow runs. 1.0 for active rules with 0 runs (earned). */
  confidence: number;
  /** Number of shadow runs observed. */
  samples: number;
  /** Days since the most recent shadow run (null if none). */
  daysSinceLastRun: number | null;
  /** Whether confidence is currently decaying (stale > decayDays). */
  decaying: boolean;
  /** Effective confidence after decay. */
  effectiveConfidence: number;
}

export interface PromotionDecision {
  ruleId: string;
  from: RuleStage;
  to: RuleStage;
  reason: string;
  eligible: boolean;
}

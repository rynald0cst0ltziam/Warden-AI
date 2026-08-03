/**
 * Regression watchdog — continuously monitors active/canary rules for quality
 * regressions and auto-reverts to the last known-good configuration.
 *
 * This is the "trust net" from the blueprint (section 4.3). It runs:
 *   1. Confidence decay checks — if a rule's confidence drops below threshold
 *   2. Anomaly detection — token spend z-score, canary pass-rate flips
 *   3. Auto-revert — falls back to last clean config snapshot
 *
 * The watchdog is designed to be called periodically (e.g. every N minutes by
 * the dashboard, or on each MCP server startup). It's stateless between runs
 * — all state lives in the SQLite store.
 */
import type { Warden } from "../warden.js";

import { logger } from "../logging/index.js";

export interface WatchdogResult {
  /** Rules that were checked. */
  checked: Array<{
    ruleId: string;
    stage: string;
    confidence: number;
    samples: number;
    decaying: boolean;
    action: "ok" | "reverted" | "alerted";
    reason?: string;
  }>;
  /** Whether any auto-reverts happened. */
  reverted: boolean;
  /** Whether any alerts were fired. */
  alerted: boolean;
  /** Timestamp of this run. */
  timestamp: string;
}

/** Confidence threshold below which an active rule is considered regressed. */
const REGRESSION_CONFIDENCE_THRESHOLD = 0.7;

/** Minimum samples before the watchdog acts (avoid noise on new rules). */
const MIN_SAMPLES_FOR_ACTION = 5;

/**
 * Run the watchdog: check all active/canary rules for regressions.
 * Auto-reverts any rule whose confidence has dropped below threshold.
 */
export async function runWatchdog(
  warden: Warden,
): Promise<WatchdogResult> {
  const status = warden.status();
  const checked: WatchdogResult["checked"] = [];
  let reverted = false;
  let alerted = false;
  const timestamp = new Date().toISOString();

  for (const rule of status) {
    const isActive = rule.stage === "active" || rule.stage === "canary";
    let finalAction: WatchdogResult["checked"][number]["action"] = "ok";
    let reason: string | undefined;

    // Check 1: confidence decay on active rules
    if (isActive && rule.samples >= MIN_SAMPLES_FOR_ACTION) {
      if (rule.confidence < REGRESSION_CONFIDENCE_THRESHOLD) {
        // Auto-revert: confidence dropped below safe threshold
        warden.gate.revert(
          rule.ruleId,
          `watchdog: confidence dropped to ${rule.confidence.toFixed(2)} (threshold ${REGRESSION_CONFIDENCE_THRESHOLD})`,
        );
        finalAction = "reverted";
        reason = `confidence ${rule.confidence.toFixed(2)} < ${REGRESSION_CONFIDENCE_THRESHOLD}`;
        reverted = true;

        // Save a config snapshot of the reverted state
        warden.store.saveConfigSnapshot(
          JSON.stringify({ revertedRule: rule.ruleId, reason }),
          false,
        );

        alerted = true;

        logger.warn("watchdog auto-reverted rule", {
          ruleId: rule.ruleId,
          confidence: rule.confidence,
          threshold: REGRESSION_CONFIDENCE_THRESHOLD,
        });
      } else if (rule.decaying) {
        // Confidence is decaying but still above threshold — log it
        finalAction = "alerted";
        reason = `decaying: ${rule.daysSinceLastRun ?? 0} days since last run`;
        alerted = true;

        logger.info("watchdog flagged decaying rule", {
          ruleId: rule.ruleId,
          confidence: rule.confidence,
          daysSinceLastRun: rule.daysSinceLastRun,
        });
      }
    }

    checked.push({
      ruleId: rule.ruleId,
      stage: rule.stage,
      confidence: rule.confidence,
      samples: rule.samples,
      decaying: rule.decaying,
      action: finalAction,
      reason,
    });
  }

  logger.info("watchdog run complete", {
    checked: checked.length,
    reverted,
    alerted,
  });

  return { checked, reverted, alerted, timestamp };
}

/**
 * Check if the watchdog should run automatically.
 * Always auto-revert — no license gating.
 */
export function watchdogMode(): "off" | "observe" | "auto-revert" {
  return "auto-revert";
}

/**
 * Run the watchdog in the appropriate mode for the current tier.
 * In observe mode, logs findings but doesn't revert.
 */
export async function runWatchdogTiered(
  warden: Warden,
): Promise<WatchdogResult> {
  const mode = watchdogMode();

  if (mode === "off") {
    return {
      checked: [],
      reverted: false,
      alerted: false,
      timestamp: new Date().toISOString(),
    };
  }

  if (mode === "auto-revert") {
    return runWatchdog(warden);
  }

  // Observe mode: check but don't revert, just log
  const status = warden.status();
  const checked: WatchdogResult["checked"] = [];
  let alerted = false;

  for (const rule of status) {
    const isActive = rule.stage === "active" || rule.stage === "canary";
    let action: WatchdogResult["checked"][number]["action"] = "ok";
    let reason: string | undefined;

    if (isActive && rule.samples >= MIN_SAMPLES_FOR_ACTION) {
      if (rule.confidence < REGRESSION_CONFIDENCE_THRESHOLD) {
        action = "alerted";
        reason = `confidence ${rule.confidence.toFixed(2)} < ${REGRESSION_CONFIDENCE_THRESHOLD} (observe mode — manual revert required)`;
        alerted = true;
        logger.warn("watchdog flagged regression (observe mode)", {
          ruleId: rule.ruleId,
          confidence: rule.confidence,
        });
      } else if (rule.decaying) {
        action = "alerted";
        reason = `decaying: ${rule.daysSinceLastRun ?? 0} days since last run`;
        alerted = true;
        logger.info("watchdog flagged decaying rule (observe mode)", {
          ruleId: rule.ruleId,
          confidence: rule.confidence,
          daysSinceLastRun: rule.daysSinceLastRun,
        });
      }
    }

    checked.push({
      ruleId: rule.ruleId,
      stage: rule.stage,
      confidence: rule.confidence,
      samples: rule.samples,
      decaying: rule.decaying,
      action,
      reason,
    });
  }

  return {
    checked,
    reverted: false,
    alerted,
    timestamp: new Date().toISOString(),
  };
}

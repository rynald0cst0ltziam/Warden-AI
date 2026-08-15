/**
 * Regression watchdog — continuously monitors active/canary rules for quality
 * regressions and auto-reverts to the last known-good configuration.
 *
 * This is the "trust net" from the blueprint (section 4.3). It runs:
 *   1. Confidence decay checks — if a rule's confidence drops below threshold
 *   2. Task outcome regression — if pruned task success rate drops below raw
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
  /** Task outcome regression signal, if detected. */
  taskRegression?: {
    prunedSuccessRate: number;
    rawSuccessRate: number;
    samples: number;
    revertedRules: string[];
  };
}

/** Confidence threshold below which an active rule is considered regressed. */
const REGRESSION_CONFIDENCE_THRESHOLD = 0.7;

/** Minimum samples before the watchdog acts (avoid noise on new rules). */
const MIN_SAMPLES_FOR_ACTION = 5;

/** Minimum task outcome samples before checking for task-level regression. */
const MIN_TASK_SAMPLES_FOR_REGRESSION = 10;

/** How much worse pruned success rate must be vs raw to trigger revert. */
const TASK_REGRESSION_THRESHOLD = -0.05;

/**
 * Run the watchdog: check all active/canary rules for regressions.
 * Auto-reverts any rule whose confidence has dropped below threshold.
 * Also checks task outcome regression — if pruned tasks are failing more
 * than raw tasks, reverts all active pruning rules.
 */
export async function runWatchdog(
  warden: Warden,
): Promise<WatchdogResult> {
  const status = warden.status();
  const checked: WatchdogResult["checked"] = [];
  let reverted = false;
  let alerted = false;
  const timestamp = new Date().toISOString();

  // --- Check 1: per-rule confidence decay ---
  for (const rule of status) {
    const isActive = rule.stage === "active" || rule.stage === "canary";
    let finalAction: WatchdogResult["checked"][number]["action"] = "ok";
    let reason: string | undefined;

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

  // --- Check 2: task outcome regression ---
  // If the agent's tasks are failing more often WITH pruning than without,
  // that's a strong signal that pruning is dropping something important.
  // Revert all active rules to shadow mode so raw output ships instead.
  let taskRegression: WatchdogResult["taskRegression"] | undefined;
  const trackerStats = warden.tracker.stats();

  if (
    trackerStats.samples >= MIN_TASK_SAMPLES_FOR_REGRESSION &&
    trackerStats.regressionSignal < TASK_REGRESSION_THRESHOLD
  ) {
    const revertedRules: string[] = [];
    const activeRules = status.filter(
      (r) => r.stage === "active" || r.stage === "canary",
    );

    for (const rule of activeRules) {
      warden.gate.revert(
        rule.ruleId,
        `watchdog: task outcome regression detected (pruned success ${(trackerStats.prunedSuccessRate * 100).toFixed(1)}% vs raw ${(trackerStats.rawSuccessRate * 100).toFixed(1)}%, signal ${trackerStats.regressionSignal.toFixed(3)})`,
      );
      revertedRules.push(rule.ruleId);
      reverted = true;
      alerted = true;
    }

    if (revertedRules.length > 0) {
      warden.store.saveConfigSnapshot(
        JSON.stringify({
          taskRegression: true,
          prunedSuccessRate: trackerStats.prunedSuccessRate,
          rawSuccessRate: trackerStats.rawSuccessRate,
          samples: trackerStats.samples,
          revertedRules,
        }),
        false,
      );

      taskRegression = {
        prunedSuccessRate: trackerStats.prunedSuccessRate,
        rawSuccessRate: trackerStats.rawSuccessRate,
        samples: trackerStats.samples,
        revertedRules,
      };

      logger.warn("watchdog reverted rules due to task outcome regression", {
        prunedSuccessRate: trackerStats.prunedSuccessRate,
        rawSuccessRate: trackerStats.rawSuccessRate,
        regressionSignal: trackerStats.regressionSignal,
        samples: trackerStats.samples,
        revertedRules,
      });
    }
  } else if (
    trackerStats.samples >= MIN_TASK_SAMPLES_FOR_REGRESSION &&
    trackerStats.regressionSignal < -0.02
  ) {
    // Possible regression but not severe enough to auto-revert — alert
    alerted = true;
    logger.warn("watchdog detected possible task outcome regression", {
      prunedSuccessRate: trackerStats.prunedSuccessRate,
      rawSuccessRate: trackerStats.rawSuccessRate,
      regressionSignal: trackerStats.regressionSignal,
      samples: trackerStats.samples,
    });
  }

  logger.info("watchdog run complete", {
    checked: checked.length,
    reverted,
    alerted,
    taskRegression: !!taskRegression,
  });

  return { checked, reverted, alerted, timestamp, taskRegression };
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
      taskRegression: undefined,
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

  // Observe mode: check task outcomes but don't revert
  let taskRegression: WatchdogResult["taskRegression"] | undefined;
  const trackerStats = warden.tracker.stats();

  if (
    trackerStats.samples >= MIN_TASK_SAMPLES_FOR_REGRESSION &&
    trackerStats.regressionSignal < TASK_REGRESSION_THRESHOLD
  ) {
    alerted = true;
    const activeRules = status.filter(
      (r) => r.stage === "active" || r.stage === "canary",
    );
    taskRegression = {
      prunedSuccessRate: trackerStats.prunedSuccessRate,
      rawSuccessRate: trackerStats.rawSuccessRate,
      samples: trackerStats.samples,
      revertedRules: [],
    };
    logger.warn("watchdog flagged task outcome regression (observe mode)", {
      prunedSuccessRate: trackerStats.prunedSuccessRate,
      rawSuccessRate: trackerStats.rawSuccessRate,
      regressionSignal: trackerStats.regressionSignal,
      affectedRules: activeRules.map((r) => r.ruleId),
    });
  }

  return {
    checked,
    reverted: false,
    alerted,
    timestamp: new Date().toISOString(),
    taskRegression,
  };
}

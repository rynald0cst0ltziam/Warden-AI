/**
 * Task outcome tracking — the verification upgrade.
 *
 * The eval gate currently checks structural parity: "did we keep the right lines?"
 * This module adds task-level evaluation: "did the agent still complete the task
 * correctly after pruning?"
 *
 * How it works:
 *   1. The agent calls `recordOutcome` after finishing a task, reporting success/failure.
 *   2. Warden correlates this with whether pruning was applied during the task.
 *   3. Over time, we compare: success rate with pruning vs. without.
 *   4. If pruned success rate drops below raw success rate, that's a regression signal.
 *
 * This is the evidence that compression didn't degrade outcomes — not just that
 * the right lines were kept, but that the agent's actual performance was maintained.
 */
import type { SqliteStore } from "../store/sqlite.js";

export interface TaskOutcomeInput {
  task: string;
  success: boolean;
  pruned: boolean;
  tokensSaved?: number;
  detail?: Record<string, unknown>;
}

export interface TaskOutcomeStats {
  total: number;
  successRate: number;
  prunedSuccessRate: number;
  rawSuccessRate: number;
  /** Difference between pruned and raw success rates. Negative = pruning may be hurting. */
  regressionSignal: number;
  samples: number;
}

export class TaskTracker {
  constructor(private store: SqliteStore) {}

  /** Record the outcome of a task. Called by the agent after completion. */
  record(input: TaskOutcomeInput): void {
    this.store.recordTaskOutcome(input);
  }

  /** Get aggregate stats comparing pruned vs. raw success rates. */
  stats(): TaskOutcomeStats {
    const raw = this.store.taskOutcomeStats();
    return {
      total: raw.total,
      successRate: raw.successRate,
      prunedSuccessRate: raw.prunedSuccessRate,
      rawSuccessRate: raw.rawSuccessRate,
      regressionSignal: raw.prunedSuccessRate - raw.rawSuccessRate,
      samples: raw.total,
    };
  }

  /**
   * Check if pruning is causing regressions.
   * Returns true if we have enough samples and pruned success rate is
   * meaningfully lower than raw success rate.
   */
  isRegressing(): boolean {
    const stats = this.stats();
    if (stats.samples < 10) return false; // not enough data
    return stats.regressionSignal < -0.05; // 5% worse with pruning
  }

  /** Human-readable summary for status output. */
  summary(): string {
    const stats = this.stats();
    if (stats.samples === 0) {
      return "no task outcomes recorded yet";
    }
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const signal =
      stats.regressionSignal > -0.02
        ? "no regression detected"
        : stats.regressionSignal > -0.05
          ? "possible regression — monitoring"
          : "regression detected — consider reverting";
    return `${stats.samples} tasks tracked | pruned: ${pct(stats.prunedSuccessRate)} success | raw: ${pct(stats.rawSuccessRate)} success | ${signal}`;
  }
}

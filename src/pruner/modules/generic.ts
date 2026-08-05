/**
 * Generic fallback pruning module.
 *
 * Used for any tool type without a dedicated module (web-fetch, raw JSON, etc.)
 * until a dedicated module is built. Strategy: structural summarization — keep
 * the head, collapse long runs of repetitive or low-signal lines, keep any line
 * that looks like an error or that matches the task relevance hint.
 */
import type {
  PruneModule,
  PruneOptions,
  PruneResult,
  RemovedSummary,
} from "../types.js";
import { approxTokens } from "../types.js";
import { annotation } from "../guard.js";
import type { TaskContext } from "../../classifier/types.js";

const ERROR_RE = /\b(error|err:|exception|traceback|panic|fatal|failed|✗)\b/i;
const LARGE_LINE_THRESHOLD = 120;

export const genericModule: PruneModule = {
  toolType: "generic",
  ruleId: "generic.structural-summary.v1",
  name: "generic structural summary",
  prune(raw: string, task: TaskContext, _opts: PruneOptions): PruneResult {
    const tokensFull = approxTokens(raw);
    const lines = raw.split(/\r?\n/);
    const hint = (task.relevanceHint ?? "").toLowerCase();
    const hintTokens = hint.split(/[^a-z0-9_]+/).filter((t) => t.length > 2);

    if (lines.length <= 80) {
      return {
        toolType: "generic",
        prunedOutput: raw,
        removed: {
          summary: "small output, returned in full",
          tokensRemoved: 0,
          counts: { lines: lines.length },
        },
        tokensFull,
        tokensPruned: tokensFull,
        ruleId: genericModule.ruleId,
        guardOk: true,
      };
    }

    const out: string[] = [];
    let collapsed = 0;
    let i = 0;
    // Keep head
    const headEnd = Math.min(20, lines.length);
    for (; i < headEnd; i++) out.push(lines[i]!);

    while (i < lines.length) {
      const l = lines[i]!;
      const low = l.toLowerCase();
      const isError = ERROR_RE.test(l);
      const isRelevant = hintTokens.some((t) => low.includes(t));
      const isLong = l.length > LARGE_LINE_THRESHOLD;
      if (isError || isRelevant) {
        out.push(l);
        i++;
        continue;
      }
      // Collapse a run of low-signal lines.
      let run = 0;
      while (i < lines.length) {
        const ll = lines[i]!;
        const llow = ll.toLowerCase();
        if (ERROR_RE.test(ll) || hintTokens.some((t) => llow.includes(t)))
          break;
        run++;
        i++;
      }
      collapsed += run;
      if (isLong)
        out.push(
          annotation(`… ${run} low-signal lines collapsed (incl. long line)`),
        );
      else out.push(annotation(`… ${run} low-signal lines collapsed`));
    }

    const prunedOutput = out.join("\n");
    const tokensPruned = approxTokens(prunedOutput);
    const removed: RemovedSummary = {
      summary: `Generic summary: kept head + error/relevance lines; collapsed ${collapsed} low-signal lines.`,
      tokensRemoved: tokensFull - tokensPruned,
      counts: { lines: lines.length, collapsed },
    };
    return {
      toolType: "generic",
      prunedOutput,
      removed,
      tokensFull,
      tokensPruned,
      ruleId: genericModule.ruleId,
      guardOk: true,
    };
  },
};

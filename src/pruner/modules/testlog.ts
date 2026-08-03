/**
 * test-runner / log-tail pruning.
 *
 * Strategy: keep failures and their immediate context, collapse passing-test
 * noise and repeated stack frames. Error/stack-trace text is never rewritten —
 * only included or excluded wholesale (the framework guard enforces this).
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

const FAIL_RE =
  /\b(fail|failed|failure|error|err:|exception|traceback|panic|fatal|✗|✘|not ok)\b/i;
const PASS_RE = /\b(pass|passed|passing|ok|✓|✔)\b/i;
const STACK_RE = /^\s*(at |File "|Traceback|Caused by|>|…\s*\d+ more)/;

export const testLogModule: PruneModule = {
  toolType: "test-log",
  ruleId: "testlog.failures-plus-context.v1",
  name: "test/log failures + context",
  prune(raw: string, _task: TaskContext, opts: PruneOptions): PruneResult {
    const ctx = opts.testLogFailureContextLines ?? 8;
    const tokensFull = approxTokens(raw);
    const lines = raw.split(/\r?\n/);

    // Mark which lines are "keep" (failure lines + context window).
    const keep = new Array<boolean>(lines.length).fill(false);
    let failCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (FAIL_RE.test(lines[i]!)) {
        failCount++;
        const lo = Math.max(0, i - ctx);
        const hi = Math.min(lines.length - 1, i + ctx);
        for (let j = lo; j <= hi; j++) keep[j] = true;
      }
    }

    if (failCount === 0) {
      // No failures: collapse to a short summary of the whole log.
      const head = lines.slice(0, Math.min(20, lines.length));
      const prunedOutput = [
        ...head,
        annotation(
          `… no failures detected; ${lines.length - head.length} trailing lines collapsed (log was clean)`,
        ),
      ].join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      const removed: RemovedSummary = {
        summary: `No failures found in ${lines.length}-line log; kept head + summary.`,
        tokensRemoved: tokensFull - tokensPruned,
        counts: { lines: lines.length, kept: head.length, failures: 0 },
      };
      return {
        toolType: "test-log",
        prunedOutput,
        removed,
        tokensFull,
        tokensPruned,
        ruleId: testLogModule.ruleId,
        guardOk: true,
      };
    }

    // Build output, collapsing runs of dropped lines into annotations.
    const out: string[] = [];
    let i = 0;
    let collapsedPassing = 0;
    let collapsedStack = 0;
    while (i < lines.length) {
      if (keep[i]) {
        out.push(lines[i]!);
        i++;
        continue;
      }
      // Count the run of dropped lines, categorize roughly.
      let runLen = 0;
      let runPass = 0;
      let runStack = 0;
      while (i < lines.length && !keep[i]) {
        const l = lines[i]!;
        if (PASS_RE.test(l)) runPass++;
        else if (STACK_RE.test(l)) runStack++;
        runLen++;
        i++;
      }
      collapsedPassing += runPass;
      collapsedStack += runStack;
      const parts: string[] = [`${runLen} lines`];
      if (runPass > 0) parts.push(`${runPass} passing`);
      if (runStack > 0) parts.push(`${runStack} stack`);
      out.push(annotation(`… ${parts.join(", ")} collapsed`));
    }

    const prunedOutput = out.join("\n");
    const tokensPruned = approxTokens(prunedOutput);
    const removed: RemovedSummary = {
      summary: `Kept ${failCount} failure(s) with ${ctx}-line context; collapsed passing-test noise and repeated stack frames.`,
      tokensRemoved: tokensFull - tokensPruned,
      counts: {
        lines: lines.length,
        failures: failCount,
        collapsedPassing,
        collapsedStack,
      },
    };
    return {
      toolType: "test-log",
      prunedOutput,
      removed,
      tokensFull,
      tokensPruned,
      ruleId: testLogModule.ruleId,
      guardOk: true,
    };
  },
};

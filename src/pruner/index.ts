/**
 * The pruning engine.
 *
 * Selects a module by tool type (with a generic fallback), runs it, then
 * enforces the trust guard: every non-annotation line in the pruned output
 * must appear verbatim in the raw output. If a module ever violates the
 * invariant (a bug), the engine refuses to ship the pruned output and falls
 * back to the raw output — safety first, optimization second.
 */
import type {
  PruneInput,
  PruneModule,
  PruneOptions,
  PruneResult,
  ToolType,
} from "./types.js";
import { verifyInclusion, neverWorse } from "./guard.js";
import { grepModule } from "./modules/grep.js";
import { fileReadModule } from "./modules/fileread.js";
import { testLogModule } from "./modules/testlog.js";
import { genericModule } from "./modules/generic.js";
import { preprocessOutput } from "./preprocess.js";
import { routeContent } from "./router.js";
import type { TaskContext } from "../classifier/types.js";
import { DEFAULT_CONFIG, type WardenConfig } from "../config/index.js";
import { logger } from "../logging/index.js";

const MODULES: Record<ToolType, PruneModule> = {
  grep: grepModule,
  search: grepModule, // search reuses grep logic
  "file-read": fileReadModule,
  "test-log": testLogModule,
  "web-fetch": genericModule, // until a dedicated module exists
  json: genericModule,
  generic: genericModule,
};

export function moduleFor(toolType: ToolType): PruneModule {
  return MODULES[toolType] ?? genericModule;
}

export function registeredModules(): PruneModule[] {
  // Unique by ruleId (search + grep share a module).
  const seen = new Set<string>();
  const out: PruneModule[] = [];
  for (const m of Object.values(MODULES)) {
    if (!seen.has(m.ruleId)) {
      seen.add(m.ruleId);
      out.push(m);
    }
  }
  return out;
}

export class PruningEngine {
  private readonly config: WardenConfig;

  constructor(config: WardenConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  private options(): PruneOptions {
    return {
      fileReadLargeThresholdLines: this.config.fileReadLargeThresholdLines,
      grepMaxMatches: this.config.grepMaxMatches,
      testLogFailureContextLines: this.config.testLogFailureContextLines,
    };
  }

  prune(input: PruneInput): PruneResult {
    // Content-aware routing: when the caller passes "generic", auto-detect
    // the actual content type and route to the best module. This makes
    // warden_prune smarter — the agent doesn't need to know what type of
    // output it's dealing with.
    let effectiveToolType = input.toolType;
    if (input.toolType === "generic") {
      const route = routeContent(input.rawOutput);
      if (route.toolType !== "generic") {
        effectiveToolType = route.toolType;
        logger.debug("content-aware routing", {
          from: "generic",
          to: route.toolType,
          confidence: route.confidence,
          reason: route.reason,
        });
      }
    }

    const mod = moduleFor(effectiveToolType);
    const opts = { ...this.options(), ...input.options };

    // Preprocessing: ANSI strip, path shorten, JSON cleanup, whitespace.
    // Runs BEFORE the pruning module, so the guard checks pruned output
    // against the preprocessed output (not the original raw). This is
    // correct — preprocessing is a safe rewrite, pruning is removal-only.
    const { output: preprocessed, stages } = preprocessOutput(input.rawOutput);
    const rawForPruning = preprocessed;

    let result: PruneResult;
    try {
      result = mod.prune(rawForPruning, input.task, opts);
    } catch (err) {
      logger.warn("pruning module threw, returning raw", {
        ruleId: mod.ruleId,
        err: String(err),
      });
      return this.fallback(input, mod.ruleId);
    }

    // Guard checks pruned output against the preprocessed output (the
    // new baseline after safe rewrites). This preserves the invariant:
    // pruning only removes, never rewrites.
    const guardOk = verifyInclusion(rawForPruning, result.prunedOutput);
    if (!guardOk) {
      // A module violated the trust invariant. Refuse to ship it.
      logger.error("guard invariant violated — reverting to raw output", {
        ruleId: result.ruleId,
        toolType: input.toolType,
      });
      return this.fallback(input, result.ruleId);
    }

    // Never-worse check: if annotations made the output larger than raw,
    // ship raw instead. Pruning should always save, never cost.
    if (!neverWorse(rawForPruning, result.prunedOutput)) {
      logger.warn("never-worse guard triggered — pruned larger than raw", {
        ruleId: result.ruleId,
        toolType: input.toolType,
      });
      return this.fallback(input, result.ruleId);
    }

    // Add preprocessing savings to the result
    if (stages.length > 0) {
      const preprocBytesSaved = input.rawOutput.length - preprocessed.length;
      const preprocTokensSaved = Math.ceil(preprocBytesSaved / 4);
      result.removed.tokensRemoved += preprocTokensSaved;
      result.tokensFull = Math.ceil(input.rawOutput.length / 4);
      result.removed.summary += ` Preprocessing: ${stages.map((s) => s.name).join(", ")}.`;
    }

    return { ...result, guardOk: true };
  }

  /** Preprocess only (no pruning). Used when rule is in shadow mode. */
  preprocessOnly(rawOutput: string): {
    output: string;
    stages: Array<{ name: string; bytesBefore: number; bytesAfter: number }>;
  } {
    return preprocessOutput(rawOutput);
  }

  /** Raw passthrough — used on guard failure or when pruning is disabled. */
  private fallback(input: PruneInput, ruleId: string): PruneResult {
    const { rawOutput } = input;
    const tokens = Math.ceil(rawOutput.length / 4);
    return {
      toolType: input.toolType,
      prunedOutput: rawOutput,
      removed: {
        summary: "raw passthrough (guard failed or pruning disabled)",
        tokensRemoved: 0,
        counts: {},
      },
      tokensFull: tokens,
      tokensPruned: tokens,
      ruleId,
      guardOk: false,
    };
  }

  /** Convenience: prune with an already-classified task. */
  pruneWithTask(
    toolType: ToolType,
    rawOutput: string,
    task: TaskContext,
    options?: PruneOptions,
  ): PruneResult {
    return this.prune({ toolType, rawOutput, task, options });
  }
}

export {
  grepModule,
  fileReadModule,
  testLogModule,
  genericModule,
} from "./modules/index.js";
export type {
  PruneInput,
  PruneModule,
  PruneOptions,
  PruneResult,
  RemovedSummary,
  ToolType,
} from "./types.js";
export { approxTokens } from "./types.js";
export { verifyInclusion, neverWorse, annotation, WARDEN_MARKER } from "./guard.js";
export { routeContent, routeMixedContent } from "./router.js";
export type { RouteResult } from "./router.js";

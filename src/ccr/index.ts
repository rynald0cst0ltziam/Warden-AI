/**
 * CCR — Compress-Cache-Retrieve.
 *
 * Makes pruning reversible. When the pruning engine removes content, the
 * original is stored in SQLite with a hash key. A retrieval marker is appended
 * to the pruned output so the agent knows it can ask for the full original.
 *
 * This eliminates the core risk of pruning: "what if we cut something
 * important?" If the agent needs the full data, it calls `warden_retrieve`
 * with the hash and gets the original back — no guesswork, no re-running tools.
 *
 * Design:
 * - Hash is SHA-256 of the raw output (first 12 hex chars — short enough for
 *   a marker, collision-resistant for tool outputs).
 * - Marker format: `‹warden› retrieve full output: warden_retrieve("abc123def456")`
 * - The marker is an annotation (prefixed with ‹warden›) so the trust guard
 *   recognizes it as added, not altered.
 * - CCR entries auto-expire after 7 days (configurable) to bound disk usage.
 * - Only stores when pruning actually removed content (tokensPruned < tokensFull).
 */
import { createHash } from "node:crypto";
import type { SqliteStore } from "../store/sqlite.js";
import { annotation, WARDEN_MARKER } from "../pruner/guard.js";
import { logger } from "../logging/index.js";

/** Default TTL for CCR entries (days). */
export const CCR_DEFAULT_TTL_DAYS = 7;

/**
 * Generate a short hash key for a raw output.
 * Uses first 12 hex chars of SHA-256 — 48 bits, ~16M distinct values.
 * Collision probability for 10K tool outputs: ~0.003%. Good enough.
 */
export function ccrHash(rawOutput: string): string {
  return createHash("sha256").update(rawOutput).digest("hex").slice(0, 12);
}

/**
 * Store the original output in CCR and return a retrieval marker.
 * Returns null if no pruning happened (tokensPruned >= tokensFull).
 */
export function storeOriginal(opts: {
  store: SqliteStore;
  rawOutput: string;
  toolType: string;
  ruleId: string;
  tokensFull: number;
  tokensPruned: number;
}): string | null {
  const {
    store,
    rawOutput,
    toolType,
    ruleId,
    tokensFull,
    tokensPruned,
  } = opts;

  // Only store if pruning actually removed content.
  if (tokensPruned >= tokensFull) return null;

  const hash = ccrHash(rawOutput);
  store.saveCcr({
    hash,
    rawOutput,
    toolType,
    ruleId,
    tokensFull,
    tokensPruned,
  });

  logger.debug("ccr stored original", {
    hash,
    toolType,
    tokensFull,
    tokensPruned,
  });

  return annotation(
    `retrieve full or sliced output: warden_retrieve("${hash}") or warden_retrieve("${hash}", around="symbolName") or warden_retrieve("${hash}", lines="120:170")`,
  );
}

/**
 * Retrieve an original output by hash. Returns the raw output or null if not
 * found (expired or never stored).
 */
export function retrieveOriginal(
  store: SqliteStore,
  hash: string,
): { rawOutput: string; toolType: string; tokensFull: number } | null {
  const row = store.getCcr(hash);
  if (!row) {
    logger.warn("ccr retrieve miss", { hash });
    return null;
  }
  logger.debug("ccr retrieved original", {
    hash,
    accessCount: row.access_count + 1,
  });
  return {
    rawOutput: row.raw_output,
    toolType: row.tool_type,
    tokensFull: row.tokens_full,
  };
}

/** Options for slice-based retrieval. */
export interface RetrieveSliceOptions {
  /** Find the first line containing this string and return context lines around it. */
  around?: string;
  /** Explicit line range [start, end] (1-based, inclusive). */
  lines?: [number, number];
  /** Lines of context above/below the `around` match (default: 10). */
  context?: number;
}

/**
 * Retrieve a slice of the original output by hash.
 *
 * Instead of returning the full raw output (which can be thousands of lines),
 * this returns only the relevant slice — either around a search string or an
 * explicit line range. The response includes a note that it's a slice, with
 * the hash for full retrieval if needed.
 *
 * Returns null if the hash is not found. Returns the full output if no slice
 * options are provided (same as retrieveOriginal).
 */
export function retrieveSlice(
  store: SqliteStore,
  hash: string,
  opts: RetrieveSliceOptions = {},
): {
  output: string;
  toolType: string;
  tokensFull: number;
  isSlice: boolean;
  sliceRange?: { start: number; end: number; totalLines: number };
} | null {
  const original = retrieveOriginal(store, hash);
  if (!original) return null;

  const lines = original.rawOutput.split(/\r?\n/);
  const totalLines = lines.length;

  // No slice options — return full output
  if (!opts.around && !opts.lines) {
    return {
      output: original.rawOutput,
      toolType: original.toolType,
      tokensFull: original.tokensFull,
      isSlice: false,
    };
  }

  let start: number;
  let end: number;

  if (opts.lines) {
    // Explicit line range (1-based, inclusive)
    start = Math.max(1, opts.lines[0]);
    end = Math.min(totalLines, opts.lines[1]);
  } else if (opts.around) {
    // Find the first line containing the search string
    const needle = opts.around.toLowerCase();
    const matchIdx = lines.findIndex(
      (l) => l.toLowerCase().includes(needle),
    );
    if (matchIdx < 0) {
      // No match — return full output with a note
      return {
        output: original.rawOutput,
        toolType: original.toolType,
        tokensFull: original.tokensFull,
        isSlice: false,
      };
    }
    const ctx = opts.context ?? 10;
    // Convert 0-based index to 1-based line numbers
    start = Math.max(1, matchIdx + 1 - ctx);
    end = Math.min(totalLines, matchIdx + 1 + ctx);
  } else {
    return {
      output: original.rawOutput,
      toolType: original.toolType,
      tokensFull: original.tokensFull,
      isSlice: false,
    };
  }

  // Extract the slice (convert 1-based to 0-based for array slicing)
  const sliceLines = lines.slice(start - 1, end);
  const header = annotation(
    `slice of original (hash=${hash}): lines ${start}-${end} of ${totalLines} — full output: warden_retrieve("${hash}")`,
  );
  const output = [header, ...sliceLines].join("\n");

  logger.debug("ccr retrieved slice", {
    hash,
    start,
    end,
    totalLines,
  });

  return {
    output,
    toolType: original.toolType,
    tokensFull: original.tokensFull,
    isSlice: true,
    sliceRange: { start, end, totalLines },
  };
}

/**
 * Check if a pruned output contains a CCR retrieval marker.
 * Returns the hash if found, null otherwise.
 */
export function extractCcrMarker(prunedOutput: string): string | null {
  const markerRe = /warden_retrieve\("([a-fA-F0-9]{12})"\)/i;
  const match = markerRe.exec(prunedOutput);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Append a CCR retrieval marker to a pruned output if content was removed.
 * Does NOT modify the output if no pruning happened.
 */
export function appendCcrMarker(
  prunedOutput: string,
  marker: string | null,
): string {
  if (!marker) return prunedOutput;
  return `${prunedOutput}\n${marker}`;
}

/**
 * Periodic cleanup — remove CCR entries older than the TTL.
 * Called by the CLI `warden ccr cleanup` command and on server startup.
 */
export function ccrCleanup(
  store: SqliteStore,
  maxAgeDays: number = CCR_DEFAULT_TTL_DAYS,
): number {
  const removed = store.ccrCleanup(maxAgeDays);
  if (removed > 0) {
    logger.info("ccr cleanup", { removed, maxAgeDays });
  }
  return removed;
}

/**
 * Summary of CCR state for status display.
 */
export function ccrSummary(store: SqliteStore): {
  count: number;
  tokensSaved: number;
} {
  return {
    count: store.ccrCount(),
    tokensSaved: store.ccrTokensSaved(),
  };
}

export { WARDEN_MARKER };

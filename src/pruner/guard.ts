/**
 * The trust guard.
 *
 * Enforces the non-negotiable invariant at the framework level: pruning only
 * REMOVES content, it never rewrites or paraphrases code, commands, or error
 * text. We enforce a strong, checkable proxy: every non-decorative line in the
 * pruned output must appear verbatim in the raw output.
 *
 * "Decorative" lines are the ones pruning modules are allowed to ADD — short
 * collapse/summary markers like "… 12 more matches collapsed" — which are
 * explicitly tagged so the guard can distinguish added annotations from
 * altered source.
 *
 * Additionally, a never-worse check ensures the pruned output is never larger
 * than the raw output (in estimated tokens). If annotations would make the
 * output bigger, the raw is shipped instead — pruning should always save, never
 * cost.
 */
export const WARDEN_MARKER = "‹warden›"; // prefix for annotations we add

import { approxTokens } from "./types.js";

export function isAnnotation(line: string): boolean {
  return line.trimStart().startsWith(WARDEN_MARKER);
}

/**
 * Verify the inclusion invariant. 
 * Enforces that every non-annotation line in `pruned` is present verbatim in `raw`,
 * AND that the lines appear in the exact same relative sequence (no reordering or unauthorized duplication).
 */
export function verifyInclusion(raw: string, pruned: string): boolean {
  const rawLines = raw.split(/\r?\n/).map(l => l.trimEnd());
  const prunedLines = pruned.split(/\r?\n/);
  
  let rawIdx = 0;
  
  for (const line of prunedLines) {
    if (line.trim().length === 0) continue; // blank lines are fine
    if (isAnnotation(line)) continue; // we're allowed to add annotations
    
    const target = line.trimEnd();
    let found = false;
    
    // Scan forward in raw to find the next matching line.
    // This strictly enforces subsequence (order and exact counts).
    while (rawIdx < rawLines.length) {
      if (rawLines[rawIdx] === target) {
        found = true;
        rawIdx++; // Consume this line so it can't be reused.
        break;
      }
      rawIdx++;
    }
    
    if (!found) return false;
  }
  
  return true;
}

/**
 * Never-worse check: ensure pruned output is not larger than raw.
 * Uses bytes/4 as a fast token estimate (same as RTK's approach).
 * Returns true if pruned is smaller or equal, false if it's worse.
 */
export function neverWorse(raw: string, pruned: string): boolean {
  const rawTokens = approxTokens(raw);
  const prunedTokens = approxTokens(pruned);
  return prunedTokens <= rawTokens;
}

/** Tag an annotation line so the guard recognizes it as added, not altered. */
export function annotation(text: string): string {
  return `${WARDEN_MARKER} ${text}`;
}

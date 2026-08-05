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

export function isAnnotation(line: string): boolean {
  return line.trimStart().startsWith(WARDEN_MARKER);
}

/**
 * Verify the inclusion invariant. Returns true if every non-annotation line in
 * `pruned` is present verbatim in `raw` (ignoring trailing whitespace).
 */
export function verifyInclusion(raw: string, pruned: string): boolean {
  const rawLines = new Set<string>();
  for (const l of raw.split(/\r?\n/)) rawLines.add(l.trimEnd());
  for (const line of pruned.split(/\r?\n/)) {
    if (line.trim().length === 0) continue; // blank lines are fine
    if (isAnnotation(line)) continue; // we're allowed to add annotations
    if (!rawLines.has(line.trimEnd())) return false;
  }
  return true;
}

/**
 * Never-worse check: ensure pruned output is not larger than raw.
 * Uses bytes/4 as a fast token estimate (same as RTK's approach).
 * Returns true if pruned is smaller or equal, false if it's worse.
 */
export function neverWorse(raw: string, pruned: string): boolean {
  const rawTokens = Math.ceil(raw.length / 4);
  const prunedTokens = Math.ceil(pruned.length / 4);
  return prunedTokens <= rawTokens;
}

/** Tag an annotation line so the guard recognizes it as added, not altered. */
export function annotation(text: string): string {
  return `${WARDEN_MARKER} ${text}`;
}

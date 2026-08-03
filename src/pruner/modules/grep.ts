/**
 * grep / search pruning.
 *
 * Strategy: keep matches relevant to the current task, collapse repeated
 * patterns, summarize match counts instead of dumping every hit. Never
 * rewrites a matched line — only includes or excludes whole lines.
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

interface ParsedMatch {
  file?: string;
  lineNo?: string;
  text: string;
  raw: string;
}

/**
 * Parse common grep formats: `path:line:content` or `path:content` or plain lines.
 *
 * Handles Windows paths with drive letters (C:\...) by treating the drive
 * letter + colon as part of the path, not as a field separator. The key
 * insight: a Windows drive letter is a single char followed by `:\`, so we
 * can detect it and skip past it when looking for the `path:line:content`
 * separator.
 */
function parseMatches(raw: string): ParsedMatch[] {
  const out: ParsedMatch[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    // Handle Windows drive letter paths: C:\path\file.ts:42:content
    // The drive letter colon is NOT a field separator — the \ after it tells us.
    const winDrive = /^([A-Za-z]:[\\\/][^:\r\n]*):(\d+)[:\-](.*)$/.exec(line);
    if (winDrive) {
      out.push({
        file: winDrive[1],
        lineNo: winDrive[2],
        text: winDrive[3] ?? "",
        raw: line,
      });
      continue;
    }
    // Windows drive letter without line number: C:\path\file.ts:content
    const winDriveNoLine = /^([A-Za-z]:[\\\/][^:\r\n]*):(.*)$/.exec(line);
    if (winDriveNoLine) {
      out.push({
        file: winDriveNoLine[1],
        text: winDriveNoLine[2] ?? "",
        raw: line,
      });
      continue;
    }

    // Standard Unix format: path:line:content
    const m = /^([^:\s][^:]*):(\d+)[:\-](.*)$/.exec(line);
    if (m) {
      out.push({ file: m[1], lineNo: m[2], text: m[3] ?? "", raw: line });
      continue;
    }
    // Standard Unix format without line number: path:content
    const m2 = /^([^:\s][^:]*):(.*)$/.exec(line);
    if (m2 && !line.startsWith(" ")) {
      out.push({ file: m2[1], text: m2[2] ?? "", raw: line });
      continue;
    }
    out.push({ text: line, raw: line });
  }
  return out;
}

function relevanceScore(m: ParsedMatch, task: TaskContext): number {
  const hint = task.relevanceHint.toLowerCase();
  const text = m.text.toLowerCase();
  let s = 0;
  // relevance-hint token overlap
  for (const tok of hint.split(/[^a-z0-9_]+/).filter((t) => t.length > 2)) {
    if (text.includes(tok)) s += 2;
    if (m.file && m.file.toLowerCase().includes(tok)) s += 3;
  }
  // errors/failures are usually high-signal for bug-fix tasks
  if (
    task.type === "bug-fix" &&
    /\b(error|fail|exception|traceback|panic)\b/i.test(m.text)
  ) {
    s += 2;
  }
  return s;
}

export const grepModule: PruneModule = {
  toolType: "grep",
  ruleId: "grep.relevance-collapse.v1",
  name: "grep relevance collapse",
  prune(raw: string, task: TaskContext, opts: PruneOptions): PruneResult {
    const max = opts.grepMaxMatches ?? 40;
    const allMatches = parseMatches(raw);
    const tokensFull = approxTokens(raw);

    // Step 1: Deduplicate exact duplicate lines (same path:line:content).
    // grep -n can produce duplicates when patterns match multiple times on
    // the same line, or when the same file is searched via multiple globs.
    // Removing exact duplicates is guard-safe (the remaining line exists in raw).
    const seen = new Set<string>();
    const matches: ParsedMatch[] = [];
    let deduped = 0;
    for (const m of allMatches) {
      if (seen.has(m.raw)) {
        deduped++;
        continue;
      }
      seen.add(m.raw);
      matches.push(m);
    }

    // If we only deduplicated (no relevance pruning needed), return early.
    if (matches.length <= max && deduped > 0) {
      const prunedOutput = matches.map((m) => m.raw).join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      const removed: RemovedSummary = {
        summary: `Removed ${deduped} duplicate match(es); ${matches.length} unique matches under threshold.`,
        tokensRemoved: tokensFull - tokensPruned,
        counts: {
          matches: allMatches.length,
          unique: matches.length,
          duplicates: deduped,
        },
      };
      return {
        toolType: "grep",
        prunedOutput,
        removed,
        tokensFull,
        tokensPruned,
        ruleId: grepModule.ruleId,
        guardOk: true,
      };
    }

    if (matches.length <= max) {
      return {
        toolType: "grep",
        prunedOutput: raw,
        removed: {
          summary: "no pruning needed (under threshold)",
          tokensRemoved: 0,
          counts: { matches: matches.length },
        },
        tokensFull,
        tokensPruned: tokensFull,
        ruleId: grepModule.ruleId,
        guardOk: true,
      };
    }

    // Step 2: Score and rank; keep top `max`, collapse the rest by file.
    const scored = matches
      .map((m) => ({ m, s: relevanceScore(m, task) }))
      .sort((a, b) => b.s - a.s);
    const kept = new Set(scored.slice(0, max).map((x) => x.m.raw));

    // Preserve original order of kept lines.
    const keptLines: string[] = [];
    const collapsedByFile = new Map<string, number>();
    let collapsedOther = 0;
    for (const m of matches) {
      if (kept.has(m.raw)) {
        keptLines.push(m.raw);
      } else if (m.file) {
        collapsedByFile.set(m.file, (collapsedByFile.get(m.file) ?? 0) + 1);
      } else {
        collapsedOther++;
      }
    }

    const annotations: string[] = [];
    if (deduped > 0) {
      annotations.push(annotation(`… ${deduped} duplicate match(es) removed`));
    }
    if (collapsedByFile.size > 0) {
      const parts = [...collapsedByFile.entries()]
        .slice(0, 5)
        .map(([f, n]) => `${n} in ${f}`);
      annotations.push(
        annotation(
          `… ${matches.length - keptLines.length} more matches collapsed (${parts.join(", ")}${collapsedByFile.size > 5 ? ", …" : ""})`,
        ),
      );
    }
    if (collapsedOther > 0) {
      annotations.push(
        annotation(`… ${collapsedOther} unattributed matches collapsed`),
      );
    }

    const prunedOutput = [...keptLines, ...annotations].join("\n");
    const tokensPruned = approxTokens(prunedOutput);
    const removed: RemovedSummary = {
      summary: `Kept top ${keptLines.length}/${matches.length} matches by task relevance; collapsed the rest with counts.${deduped > 0 ? ` Removed ${deduped} duplicates.` : ""}`,
      tokensRemoved: tokensFull - tokensPruned,
      counts: {
        matches: allMatches.length,
        unique: matches.length,
        duplicates: deduped,
        kept: keptLines.length,
        collapsed: matches.length - keptLines.length,
      },
    };
    return {
      toolType: "grep",
      prunedOutput,
      removed,
      tokensFull,
      tokensPruned,
      ruleId: grepModule.ruleId,
      guardOk: true,
    };
  },
};

/**
 * Session handoff — generates a compact summary of the current session for
 * continuity across session boundaries.
 *
 * When a session ends or hits a context limit, the agent (or user) calls
 * `warden handoff` to distill the session's activity into a structured
 * document under ~300 words. The next session starts with this document
 * instead of re-explaining everything.
 *
 * Sources:
 *   - memories saved this session (decisions, findings, patterns)
 *   - task outcomes recorded this session (success/failure)
 *   - context selections this session (files touched)
 *   - pruning decisions this session (tokens saved)
 *
 * The handoff window is "since the last handoff" (tracked via a metadata
 * table) or "the last N hours" if no previous handoff exists.
 */
import type { SqliteStore } from "../store/sqlite.js";

/** Default lookback window when no previous handoff exists. */
const DEFAULT_WINDOW_HOURS = 8;

/** Maximum items per section to keep the handoff compact. */
const MAX_MEMORIES = 10;
const MAX_OUTCOMES = 10;
const MAX_FILES = 15;
const MAX_DECISIONS = 5;

export interface HandoffResult {
  /** The markdown handoff document. */
  document: string;
  /** When this handoff was generated. */
  timestamp: string;
  /** When the window starts (inclusive). */
  windowStart: string;
  /** Counts of items in each section. */
  counts: {
    memories: number;
    outcomes: number;
    filesTouched: number;
    decisions: number;
  };
}

export class HandoffGenerator {
  constructor(private store: SqliteStore) {}

  /**
   * Generate a session handoff document.
   *
   * @param windowHours Lookback window in hours (default: 8, or since last handoff).
   */
  generate(windowHours: number = DEFAULT_WINDOW_HOURS): HandoffResult {
    const now = new Date();
    const timestamp = now.toISOString();

    // Determine window start: last handoff timestamp or now - windowHours
    const lastHandoff = this.getLastHandoffTime();
    const windowStart = lastHandoff ?? new Date(now.getTime() - windowHours * 3600_000).toISOString();

    const memories = this.getMemoriesSince(windowStart);
    const outcomes = this.getOutcomesSince(windowStart);
    const filesTouched = this.getContextSelectionsSince(windowStart);
    const decisions = this.getDecisionsSince(windowStart);

    const doc = this.buildDocument({
      timestamp,
      windowStart,
      memories,
      outcomes,
      filesTouched,
      decisions,
    });

    // Record this handoff so the next one starts from here
    this.recordHandoff(timestamp, doc);

    return {
      document: doc,
      timestamp,
      windowStart,
      counts: {
        memories: memories.length,
        outcomes: outcomes.length,
        filesTouched: filesTouched.length,
        decisions: decisions.length,
      },
    };
  }

  /**
   * Read the last generated handoff document without generating a new one.
   * Returns null if no handoff has been generated yet.
   */
  readLast(): { document: string; timestamp: string } | null {
    try {
      const row = this.store.db
        .prepare("SELECT value FROM warden_meta WHERE key = 'last_handoff_doc'")
        .get() as { value: string } | undefined;
      if (!row?.value) return null;
      const tsRow = this.store.db
        .prepare("SELECT value FROM warden_meta WHERE key = 'last_handoff_at'")
        .get() as { value: string } | undefined;
      return {
        document: row.value,
        timestamp: tsRow?.value ?? new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private getLastHandoffTime(): string | null {
    try {
      const row = this.store.db
        .prepare("SELECT value FROM warden_meta WHERE key = 'last_handoff_at'")
        .get() as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      // Table may not exist yet — treat as no previous handoff
      return null;
    }
  }

  private recordHandoff(timestamp: string, document: string): void {
    this.ensureMetaTable();
    try {
      this.store.db
        .prepare(
          "INSERT INTO warden_meta (key, value) VALUES ('last_handoff_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(timestamp);
      this.store.db
        .prepare(
          "INSERT INTO warden_meta (key, value) VALUES ('last_handoff_doc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(document);
    } catch {
      // Best-effort — don't fail the handoff
    }
  }

  private ensureMetaTable(): void {
    try {
      this.store.db.exec(
        "CREATE TABLE IF NOT EXISTS warden_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    } catch {
      // best-effort
    }
  }

  private getMemoriesSince(since: string): Array<{
    timestamp: string;
    category: string;
    title: string;
    tags_json: string;
  }> {
    try {
      return this.store.db
        .prepare(
          "SELECT timestamp, category, title, tags_json FROM memories WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(since, MAX_MEMORIES) as Array<{
        timestamp: string;
        category: string;
        title: string;
        tags_json: string;
      }>;
    } catch {
      return [];
    }
  }

  private getOutcomesSince(since: string): Array<{
    timestamp: string;
    task: string;
    success: number;
    pruned: number;
    tokens_saved: number;
  }> {
    try {
      return this.store.db
        .prepare(
          "SELECT timestamp, task, success, pruned, tokens_saved FROM task_outcomes WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(since, MAX_OUTCOMES) as Array<{
        timestamp: string;
        task: string;
        success: number;
        pruned: number;
        tokens_saved: number;
      }>;
    } catch {
      return [];
    }
  }

  private getContextSelectionsSince(since: string): string[] {
    try {
      const rows = this.store.db
        .prepare(
          "SELECT files_json FROM context_selections WHERE timestamp >= ? ORDER BY timestamp DESC",
        )
        .all(since) as { files_json: string }[];
      const allFiles = new Set<string>();
      for (const row of rows) {
        try {
          const files = JSON.parse(row.files_json) as string[];
          for (const f of files) allFiles.add(f);
        } catch {
          // skip malformed
        }
      }
      return [...allFiles].slice(0, MAX_FILES);
    } catch {
      return [];
    }
  }

  private getDecisionsSince(since: string): Array<{
    timestamp: string;
    kind: string;
    rule_id: string | null;
    tokens_saved: number;
  }> {
    try {
      return this.store.db
        .prepare(
          "SELECT timestamp, kind, rule_id, tokens_saved FROM decisions WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(since, MAX_DECISIONS) as Array<{
        timestamp: string;
        kind: string;
        rule_id: string | null;
        tokens_saved: number;
      }>;
    } catch {
      return [];
    }
  }

  private buildDocument(opts: {
    timestamp: string;
    windowStart: string;
    memories: Array<{ timestamp: string; category: string; title: string; tags_json: string }>;
    outcomes: Array<{ timestamp: string; task: string; success: number; pruned: number; tokens_saved: number }>;
    filesTouched: string[];
    decisions: Array<{ timestamp: string; kind: string; rule_id: string | null; tokens_saved: number }>;
  }): string {
    const lines: string[] = [
      `# Session Handoff — ${opts.timestamp.slice(0, 19).replace("T", " ")}`,
      "",
    ];

    // Decisions & findings
    if (opts.memories.length > 0) {
      lines.push("## Decisions & Findings");
      for (const m of opts.memories) {
        let tags = "";
        try {
          const parsed = JSON.parse(m.tags_json) as string[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            tags = ` [${parsed.join(", ")}]`;
          }
        } catch {
          // no tags
        }
        lines.push(`- **${m.category}**: ${m.title}${tags}`);
      }
      lines.push("");
    }

    // Task outcomes
    if (opts.outcomes.length > 0) {
      const successes = opts.outcomes.filter((o) => o.success).length;
      const failures = opts.outcomes.length - successes;
      const totalTokensSaved = opts.outcomes.reduce((acc, o) => acc + o.tokens_saved, 0);
      lines.push("## Task Outcomes");
      lines.push(`${opts.outcomes.length} tasks: ${successes} succeeded, ${failures} failed. ${totalTokensSaved} tokens saved.`);
      for (const o of opts.outcomes) {
        const status = o.success ? "DONE" : "FAILED";
        const pruned = o.pruned ? " (pruned)" : "";
        lines.push(`- [${status}] ${o.task}${pruned}`);
      }
      lines.push("");
    }

    // Files touched
    if (opts.filesTouched.length > 0) {
      lines.push("## Files Touched");
      for (const f of opts.filesTouched) {
        // Show relative path if possible (strip common prefix)
        lines.push(`- ${f}`);
      }
      lines.push("");
    }

    // Pruning decisions
    if (opts.decisions.length > 0) {
      const totalSaved = opts.decisions.reduce((acc, d) => acc + d.tokens_saved, 0);
      lines.push("## Pruning Activity");
      lines.push(`${opts.decisions.length} decisions, ${totalSaved} tokens saved.`);
      lines.push("");
    }

    // If nothing happened
    if (
      opts.memories.length === 0 &&
      opts.outcomes.length === 0 &&
      opts.filesTouched.length === 0 &&
      opts.decisions.length === 0
    ) {
      lines.push("No session activity recorded since " + opts.windowStart.slice(0, 19).replace("T", " ") + ".");
      lines.push("");
      lines.push("This is normal if:");
      lines.push("- This is the first session with Warden");
      lines.push("- The agent didn't call warden_memory_save or warden_record_outcome");
      lines.push("- The session was very short");
    }

    return lines.join("\n");
  }
}

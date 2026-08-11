/**
 * Agent memory — Layer 3 of Warden's context governance.
 *
 * Layers 1 and 2 govern *input* context (which files to read, how to prune
 * tool output). Layer 3 governs *durable* context: the project decisions,
 * findings, patterns, constraints, and preferences the agent accumulates
 * across tasks.
 *
 *   AFTER a task:  the agent calls `save()` to persist a decision worth
 *                  remembering (e.g. "Using Stripe for payments",
 *                  "Database is PostgreSQL", "Auth uses JWT + refresh
 *                  tokens").
 *   BEFORE a task: the agent calls `recall()` to surface past decisions
 *                  relevant to the work about to start.
 *
 * Memories are stored in the local SqliteStore (see `src/store/sqlite.ts`)
 * and never leave the machine. Recall is a simple text match today; the
 * access-time touch keeps recently-useful memories surfaced first.
 */

/** Shape of a memory the agent wants to persist. */
export interface MemoryInput {
  /** "decision" | "finding" | "pattern" | "constraint" | "preference" | "failed_approach" */
  category: string;
  /** Short summary, e.g. "Use Stripe for payments". */
  title: string;
  /** Detailed explanation of the decision and its rationale. */
  body: string;
  /** Free-form tags for recall, e.g. ["payments", "billing", "stripe"]. */
  tags: string[];
  /** What triggered this memory (e.g. "user request", "code analysis"). */
  source?: string;
  // P1: Structured provenance
  /** Type of source: "human" | "agent" | "documentation" | "commit" | "configuration" | "code" | "test" | "explicit_user_instruction" */
  sourceType?: string;
  /** Evidence references (file paths, commit SHAs, URLs). */
  evidence?: string[];
  /** Scope of the decision (file path, module, or null for global). */
  scope?: string;
  /** Outcome: "success" | "failure" | null. Used for failed approach tracking. */
  outcome?: string;
  /** ID of the decision this one supersedes. */
  supersedesId?: number;
}

/** A memory as returned to the agent, with bookkeeping fields attached. */
export interface MemoryResult {
  id: number;
  timestamp: string;
  category: string;
  title: string;
  body: string;
  tags: string[];
  source: string | null;
  confidence: number;
  accessedAt: string | null;
  accessCount: number;
  // P1: Structured decision memory
  status: string;
  scope: string | null;
  supersedesId: number | null;
  sourceType: string | null;
  evidence: string[];
  outcome: string | null;
  reaffirmedCount: number;
  lastReaffirmedAt: string | null;
}

/**
 * Raw row shape returned by the store's memory methods. Mirrors the
 * `MemoryRow` in `src/store/sqlite.ts` but kept local so this module has no
 * hard dependency on the store's concrete types.
 */
interface MemoryRow {
  id: number;
  timestamp: string;
  category: string;
  title: string;
  body: string;
  tags_json: string;
  source: string | null;
  confidence: number;
  accessed_at: string | null;
  access_count: number;
  // P1: Structured decision memory
  status: string;
  scope: string | null;
  supersedes_id: number | null;
  source_type: string | null;
  evidence_json: string;
  outcome: string | null;
  reaffirmed_count: number;
  last_reaffirmed_at: string | null;
}

/**
 * Subset of the store this module needs. Injected so the memory module stays
 * decoupled from the concrete `SqliteStore` (useful for tests and alternate
 * backends).
 */
export interface MemoryStore {
  saveMemory(opts: MemoryInput): number;
  recallMemories(query: string, limit?: number): MemoryRow[];
  listMemories(limit?: number): MemoryRow[];
  touchMemory(id: number): void;
  forgetMemory(id: number): boolean;
  findMemoryConflicts(title: string, category: string): MemoryRow[];
  // P1: Decision lifecycle
  reaffirmMemory(id: number): boolean;
  supersedeMemory(oldId: number, newId: number): boolean;
  archiveMemory(id: number): boolean;
  markContestedMemory(id: number): boolean;
  rejectMemory(id: number): boolean;
  getMemory(id: number): MemoryRow | undefined;
  findFailedApproaches(query: string, limit?: number): MemoryRow[];
}

/**
 * Agent memory facade. Wraps the store with validation, access-time tracking,
 * and a clean `MemoryResult` shape (parsed tags, camelCase fields).
 */
export class AgentMemory {
  constructor(private store: MemoryStore) {}

  /**
   * Persist a durable project decision.
   *
   * Validates that `title` and `body` are non-empty (after trimming) before
   * delegating to the store. Returns the new memory's numeric id, or throws
   * if the input is invalid.
   */
  save(input: MemoryInput): number {
    if (input.title.trim().length === 0) {
      throw new Error("Memory title must not be empty");
    }
    if (input.body.trim().length === 0) {
      throw new Error("Memory body must not be empty");
    }
    const id = this.store.saveMemory({
      category: input.category,
      title: input.title,
      body: input.body,
      tags: input.tags,
      source: input.source,
      sourceType: input.sourceType,
      evidence: input.evidence,
      scope: input.scope,
      outcome: input.outcome,
      supersedesId: input.supersedesId,
    });
    // If this decision supersedes another, mark the old one.
    // Done after save so the new ID is known and the old is only
    // marked if the save succeeded.
    if (input.supersedesId) {
      this.store.supersedeMemory(input.supersedesId, id);
    }
    return id;
  }

  /**
   * Recall memories relevant to a task.
   *
   * Searches the store for text matches, touches (updates access time/count
   * for) each result so recently-useful memories resurface, then converts the
   * raw rows to `MemoryResult` and sorts by relevance: recently accessed
   * first, then recently created.
   */
  recall(query: string, limit?: number): MemoryResult[] {
    const rows = this.store.recallMemories(query, limit);
    const results = rows.map((row) => {
      // Touch each recalled memory so its access time/count stays fresh.
      this.store.touchMemory(row.id);
      return this.toResult(row);
    });
    // Sort by relevance: most recently accessed first, then most recently
    // created. Memories that have never been accessed sort after ones that
    // have, but still by creation recency among themselves.
    return results.sort((a, b) => {
      const aAccessed = a.accessedAt ?? "";
      const bAccessed = b.accessedAt ?? "";
      if (aAccessed !== bAccessed) {
        return bAccessed < aAccessed ? -1 : 1;
      }
      return b.timestamp < a.timestamp ? -1 : 1;
    });
  }

  /**
   * List all stored memories, most recently created first.
   */
  list(limit?: number): MemoryResult[] {
    const rows = this.store.listMemories(limit);
    return rows.map((row) => this.toResult(row));
  }

  /**
   * Find memories that potentially conflict with a given title + category.
   * Useful after saving a new decision to check if it contradicts an
   * existing one (e.g. "Use PayPal" after "Use Stripe").
   */
  findConflicts(title: string, category: string): MemoryResult[] {
    const rows = this.store.findMemoryConflicts(title, category);
    return rows.map((row) => this.toResult(row));
  }

  /**
   * Remove an outdated or incorrect memory by id. Returns `true` if a row was
   * actually deleted.
   */
  forget(id: number): boolean {
    return this.store.forgetMemory(id);
  }

  // ---- P1: Decision lifecycle ----

  /**
   * Reaffirm a decision — signals that this decision was referenced and
   * found to still be valid. Increments reaffirmed_count and updates
   * last_reaffirmed_at.
   */
  reaffirm(id: number): boolean {
    return this.store.reaffirmMemory(id);
  }

  /**
   * Supersede a decision — marks the old decision as 'superseded' and links
   * it to the new one. The new decision should be saved first (with
   * supersedesId set to the old id), then call this to update the old.
   */
  supersede(oldId: number, newId: number): boolean {
    return this.store.supersedeMemory(oldId, newId);
  }

  /** Archive a decision — set status to 'expired'. */
  archive(id: number): boolean {
    return this.store.archiveMemory(id);
  }

  /** Mark a decision as contested — someone/something disagrees. */
  markContested(id: number): boolean {
    return this.store.markContestedMemory(id);
  }

  /** Reject a decision — set status to 'rejected'. */
  reject(id: number): boolean {
    return this.store.rejectMemory(id);
  }

  /**
   * Find failed approaches relevant to a query.
   * Returns memories with outcome='failure' that match the query.
   * Used to surface past failures when the agent proposes a similar approach.
   */
  findFailedApproaches(query: string, limit?: number): MemoryResult[] {
    const rows = this.store.findFailedApproaches(query, limit);
    return rows.map((row) => this.toResult(row));
  }

  /**
   * Convert a raw store row (snake_case, `tags_json` string) into the clean
   * `MemoryResult` shape (camelCase, parsed `tags` array). Falls back to an
   * empty tag array if the JSON is missing or malformed.
   */
  private toResult(row: MemoryRow): MemoryResult {
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // Malformed or missing tags_json — treat as no tags.
    }
    let evidence: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.evidence_json ?? "[]");
      if (Array.isArray(parsed)) {
        evidence = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // Malformed or missing evidence_json — treat as no evidence.
    }
    return {
      id: row.id,
      timestamp: row.timestamp,
      category: row.category,
      title: row.title,
      body: row.body,
      tags,
      source: row.source,
      confidence: row.confidence,
      accessedAt: row.accessed_at,
      accessCount: row.access_count,
      // P1 fields
      status: row.status ?? "active",
      scope: row.scope ?? null,
      supersedesId: row.supersedes_id ?? null,
      sourceType: row.source_type ?? null,
      evidence,
      outcome: row.outcome ?? null,
      reaffirmedCount: row.reaffirmed_count ?? 0,
      lastReaffirmedAt: row.last_reaffirmed_at ?? null,
    };
  }
}

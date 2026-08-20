/**
 * Agent memory — Layer 3 of Warden's context optimization.
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

import {
  embed,
  embedBatch,
  warmEmbeddings,
  embeddingsAvailable,
  embeddingsFailed,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
} from "./embeddings.js";

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
  // Semantic search: embedding storage
  setMemoryEmbedding(id: number, embedding: Buffer): void;
  getMemoryEmbedding(id: number): Buffer | null;
  allMemoryEmbeddings(): Array<{ id: number; embedding: Buffer }>;
  countEmbeddedMemories(): number;
}

/**
 * Agent memory facade. Wraps the store with validation, access-time tracking,
 * and a clean `MemoryResult` shape (parsed tags, camelCase fields).
 *
 * Recall uses hybrid search: FTS5 (keyword, porter-stemmed) + vector
 * (semantic, all-MiniLM-L6-v2 embeddings) merged via Reciprocal Rank Fusion.
 * If the embedding model is unavailable, recall falls back to FTS5 only.
 */
export class AgentMemory {
  /** Cached embeddings for vector search. Invalidated on save/forget. */
  private embeddingCache: Map<number, Float32Array> | null = null;
  /** Whether the embedding cache covers all current memories. */
  private embeddingCacheStale = true;

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
    // Fire-and-forget: generate embedding for this memory so future
    // recall() calls can use semantic search. Non-blocking — if this
    // fails, recall falls back to FTS5. The cache is marked stale so
    // the next recall reloads it.
    this.embeddingCacheStale = true;
    void this.generateEmbeddingForMemory(id, input.title, input.body, input.tags);
    return id;
  }

  /**
   * Recall memories relevant to a task using hybrid search.
   *
   * Runs two search strategies:
   *   1. FTS5 keyword search (porter-stemmed, tokenized) — exact term matching
   *   2. Vector semantic search (all-MiniLM-L6-v2 cosine similarity) — intent matching
   *
   * Results are merged using Reciprocal Rank Fusion (RRF, k=60):
   *   score = 1/(k + rank_fts) + 1/(k + rank_vec)
   *
   * This means a memory found by BOTH methods ranks higher than one found by
   * only one. Memories found by semantic search but not FTS5 (e.g. "login"
   * query matching "authentication approach" memory) are still surfaced.
   *
   * Non-blocking: if the embedding model is not yet loaded, recall uses FTS5
   * only and triggers model loading in the background for subsequent calls.
   * If the model has permanently failed, FTS5 is used for the session.
   *
   * Touches (updates access time/count) for each result.
   */
  async recall(query: string, limit?: number): Promise<MemoryResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      const rows = this.store.listMemories(limit);
      return rows.map((row) => this.toResult(row));
    }

    // 1. FTS5 keyword search (always available, fast)
    const ftsRows = this.store.recallMemories(trimmed, limit ?? 10);
    const ftsRanked = ftsRows.map((row, idx) => ({ id: row.id, row, rank: idx + 1 }));

    // 2. Vector semantic search — ONLY if model is already loaded.
    //    If not loaded, trigger loading in background and use FTS5 only.
    //    This ensures recall never blocks on model download/loading.
    let vecRanked: Array<{ id: number; row: MemoryRow; rank: number }> = [];
    if (embeddingsAvailable()) {
      // Model is loaded — backfill any missing embeddings, then search
      await this.ensureEmbeddings();
      const queryEmb = await embed(trimmed);
      if (queryEmb) {
        const allEmbs = this.getEmbeddingCache();
        if (allEmbs.size > 0) {
          const scored: Array<{ id: number; row: MemoryRow; score: number }> = [];
          for (const [id, emb] of allEmbs) {
            const row = this.store.getMemory(id);
            if (!row) continue;
            if (row.status && row.status !== "active") continue;
            const sim = cosineSimilarity(queryEmb, emb);
            scored.push({ id, row, score: sim });
          }
          scored.sort((a, b) => b.score - a.score);
          vecRanked = scored.map((s, idx) => ({ id: s.id, row: s.row, rank: idx + 1 }));
        }
      }
    } else if (!embeddingsFailed()) {
      // Model not yet loaded — trigger loading + backfill in background.
      // Next recall() will use hybrid search. This one uses FTS5 only.
      void this.warmAndBackfill();
    }

    // 3. Merge with Reciprocal Rank Fusion (RRF, k=60)
    const merged = this.rrfMerge(ftsRanked, vecRanked, limit ?? 10);

    // 4. Touch and convert to MemoryResult
    const results = merged.map((entry) => {
      this.store.touchMemory(entry.id);
      return this.toResult(entry.row);
    });

    return results;
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

  // ---- Hybrid search internals ----

  /** RRF constant — standard value from the original paper. */
  private static readonly RRF_K = 60;

  /**
   * Merge FTS5 and vector search results using Reciprocal Rank Fusion.
   * Each result's score = 1/(k + rank_fts) + 1/(k + rank_vec).
   * Memories found by both methods rank higher than those found by one.
   * Memories found by only one method still get a score from that method.
   */
  private rrfMerge(
    ftsRanked: Array<{ id: number; row: MemoryRow; rank: number }>,
    vecRanked: Array<{ id: number; row: MemoryRow; rank: number }>,
    limit: number,
  ): Array<{ id: number; row: MemoryRow }> {
    const k = AgentMemory.RRF_K;
    const scores = new Map<number, { score: number; row: MemoryRow }>();

    for (const entry of ftsRanked) {
      const rrfScore = 1 / (k + entry.rank);
      scores.set(entry.id, { score: rrfScore, row: entry.row });
    }

    for (const entry of vecRanked) {
      const rrfScore = 1 / (k + entry.rank);
      const existing = scores.get(entry.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(entry.id, { score: rrfScore, row: entry.row });
      }
    }

    // Sort by RRF score descending, then by access recency as tiebreaker
    const entries = Array.from(scores.entries()).map(([id, { score, row }]) => ({
      id,
      score,
      row,
    }));
    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreaker: recently accessed first, then recently created
      const aAccessed = a.row.accessed_at ?? "";
      const bAccessed = b.row.accessed_at ?? "";
      if (aAccessed !== bAccessed) return bAccessed < aAccessed ? -1 : 1;
      return b.row.timestamp < a.row.timestamp ? -1 : 1;
    });

    return entries.slice(0, limit).map((e) => ({ id: e.id, row: e.row }));
  }

  /**
   * Get the in-memory embedding cache. Loads from the store on first access
   * or when stale. Returns a map of memory id → Float32Array.
   */
  private getEmbeddingCache(): Map<number, Float32Array> {
    if (this.embeddingCache && !this.embeddingCacheStale) {
      return this.embeddingCache;
    }
    const rows = this.store.allMemoryEmbeddings();
    const cache = new Map<number, Float32Array>();
    for (const row of rows) {
      const emb = bufferToEmbedding(row.embedding);
      if (emb) cache.set(row.id, emb);
    }
    this.embeddingCache = cache;
    this.embeddingCacheStale = false;
    return cache;
  }

  /**
   * Ensure all existing memories have embeddings. Called on first recall()
   * to backfill memories created before semantic search was enabled.
   * Runs in the background — recall doesn't wait for backfill to complete
   * (it uses whatever embeddings are available at the moment).
   */
  /**
   * Warm the embedding model and backfill any missing embeddings.
   * Called fire-and-forget — never blocks recall(). Once complete,
   * subsequent recall() calls will use hybrid search.
   */
  private async warmAndBackfill(): Promise<void> {
    const ok = await warmEmbeddings();
    if (ok) {
      await this.ensureEmbeddings();
    }
  }

  private async ensureEmbeddings(): Promise<void> {
    if (embeddingsFailed()) return;

    try {
      // Check if there are memories without embeddings
      const allMemories = this.store.listMemories(100000);
      const missing = allMemories.filter((m) => {
        // Only embed active memories
        if (m.status && m.status !== "active") return false;
        return !this.store.getMemoryEmbedding(m.id);
      });

      if (missing.length === 0) return;

      // Backfill in batches of 32 to avoid memory spikes
      const BATCH = 32;
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        const texts = batch.map((m) => `${m.title} ${m.body} ${m.tags_json}`);
        const embeddings = await embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          const emb = embeddings[j];
          if (emb) {
            this.store.setMemoryEmbedding(batch[j]!.id, embeddingToBuffer(emb));
          }
        }
      }
      // Invalidate cache so next recall picks up the new embeddings
      this.embeddingCacheStale = true;
    } catch {
      // DB may have been closed or model failed mid-batch. Non-fatal —
      // FTS5 search still works, backfill will retry on next recall.
    }
  }

  /**
   * Generate and store an embedding for a single memory.
   * Called fire-and-forget after save() — non-blocking.
   */
  private async generateEmbeddingForMemory(
    id: number,
    title: string,
    body: string,
    tags: string[],
  ): Promise<void> {
    if (embeddingsFailed()) return;

    try {
      const text = `${title} ${body} ${tags.join(" ")}`;
      const emb = await embed(text);
      if (emb) {
        this.store.setMemoryEmbedding(id, embeddingToBuffer(emb));
        this.embeddingCacheStale = true;
      }
    } catch {
      // DB may have been closed (e.g. CLI process exiting). The embedding
      // will be generated on the next recall via ensureEmbeddings() backfill.
      // Non-fatal — FTS5 search still works.
    }
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

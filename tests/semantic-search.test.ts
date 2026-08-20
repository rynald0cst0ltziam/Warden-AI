/**
 * Semantic memory search tests — hybrid search, RRF fusion, embedding
 * storage, graceful degradation.
 *
 * These tests run in two modes:
 *   1. WARDEN_NO_EMBEDDINGS=1 — verifies FTS5-only fallback works correctly
 *   2. Without the flag — verifies full hybrid search (requires model download
 *      on first run, so tests have extended timeouts)
 *
 * The semantic matching tests (e.g. "login" finds "authentication") are
 * skipped when embeddings are disabled, since they require the embedding model.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { AgentMemory } from "../src/memory/index.js";
import {
  embed,
  embedBatch,
  warmEmbeddings,
  embeddingsAvailable,
  embeddingsFailed,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  EMBEDDING_DIM,
} from "../src/memory/embeddings.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NO_EMBEDDINGS =
  process.env.WARDEN_NO_EMBEDDINGS === "1" ||
  process.env.WARDEN_NO_EMBEDDINGS === "true";

// Extended timeout for model download on first run
const TEST_TIMEOUT = NO_EMBEDDINGS ? 10000 : 120000;

const TEST_DIR = join(tmpdir(), `warden-semsearch-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let store: SqliteStore;
let memory: AgentMemory;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = await SqliteStore.open(TEST_DB);
  memory = new AgentMemory(store);

  // If embeddings are enabled, warm the model before tests
  if (!NO_EMBEDDINGS) {
    await warmEmbeddings();
  }
}, TEST_TIMEOUT);

afterAll(() => {
  store.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

beforeEach(() => {
  // Clean all memories between tests
  store.db.exec("DELETE FROM memories");
  try {
    store.db.exec("DELETE FROM memories_fts");
  } catch {
    // FTS might not exist
  }
});

describe("Embedding module — core functions", () => {
  it("cosineSimilarity returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("cosineSimilarity returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("cosineSimilarity returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("cosineSimilarity returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("embeddingToBuffer and bufferToEmbedding round-trip", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, -0.4, 0.5]);
    const buf = embeddingToBuffer(original);
    expect(buf.length).toBe(20); // 5 floats × 4 bytes
    const restored = bufferToEmbedding(buf);
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(restored![i]).toBeCloseTo(original[i], 5);
    }
  });

  it("bufferToEmbedding returns null for empty or invalid buffer", () => {
    expect(bufferToEmbedding(null)).toBeNull();
    expect(bufferToEmbedding(undefined)).toBeNull();
    expect(bufferToEmbedding(Buffer.alloc(0))).toBeNull();
    // 3 bytes is not a multiple of 4
    expect(bufferToEmbedding(Buffer.alloc(3))).toBeNull();
  });

  it("EMBEDDING_DIM is 384", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});

describe("Embedding module — model availability", () => {
  it("embeddingsFailed reflects WARDEN_NO_EMBEDDINGS env var", () => {
    if (NO_EMBEDDINGS) {
      expect(embeddingsFailed()).toBe(true);
      expect(embeddingsAvailable()).toBe(false);
    } else {
      // After warmEmbeddings() in beforeAll, model should be available
      // (unless download failed — in which case it's failed, not available)
      expect(embeddingsAvailable() || embeddingsFailed()).toBe(true);
    }
  });
});

// Semantic matching tests — only run when embeddings are enabled
describe.skipIf(NO_EMBEDDINGS)("Embedding generation", () => {
  it(
    "embed() returns a 384-dim Float32Array",
    async () => {
      const result = await embed("authentication using JWT tokens");
      expect(result).not.toBeNull();
      expect(result!.length).toBe(EMBEDDING_DIM);
      // Vectors should be normalized (L2 norm ≈ 1)
      let norm = 0;
      for (let i = 0; i < result!.length; i++) norm += result![i]! ** 2;
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
    },
    TEST_TIMEOUT,
  );

  it(
    "embedBatch() returns aligned results for multiple texts",
    async () => {
      const texts = ["hello world", "authentication approach", "database design"];
      const results = await embedBatch(texts);
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r).not.toBeNull();
        expect(r!.length).toBe(EMBEDDING_DIM);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "semantically similar texts have higher cosine similarity than dissimilar ones",
    async () => {
      const auth1 = await embed("user login and authentication");
      const auth2 = await embed("credential verification and access control");
      const db = await embed("database query optimization");

      expect(auth1).not.toBeNull();
      expect(auth2).not.toBeNull();
      expect(db).not.toBeNull();

      const simSimilar = cosineSimilarity(auth1!, auth2!);
      const simDifferent = cosineSimilarity(auth1!, db!);

      // Similar concepts should have higher similarity than unrelated ones
      expect(simSimilar).toBeGreaterThan(simDifferent);
    },
    TEST_TIMEOUT,
  );
});

// Semantic search integration tests — only when embeddings are enabled
describe.skipIf(NO_EMBEDDINGS)("AgentMemory — semantic search", () => {
  it(
    "recall finds memories by semantic similarity, not just keyword match",
    async () => {
      // Save a memory about authentication — no "login" keyword
      memory.save({
        category: "decision",
        title: "Use JWT for authentication",
        body: "We use JSON Web Tokens with refresh tokens for access control.",
        tags: ["auth", "jwt", "security"],
      });

      // Wait for async embedding to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Search with "login" — no keyword overlap, but semantically related
      const results = await memory.recall("login");

      // Should find the authentication memory via semantic search
      expect(results.length).toBeGreaterThanOrEqual(1);
      const titles = results.map((r) => r.title);
      expect(titles.some((t) => t.includes("authentication"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "recall surfaces memories that FTS5 would miss (semantic gap)",
    async () => {
      // Save a memory about payment processing
      memory.save({
        category: "decision",
        title: "Use Stripe for payment processing",
        body: "Stripe handles credit card transactions and recurring billing.",
        tags: ["payments", "billing"],
      });

      // Save an unrelated memory
      memory.save({
        category: "decision",
        title: "Use Redis for caching",
        body: "Redis for session storage and cache.",
        tags: ["cache", "redis"],
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // "credit card" should find the Stripe memory even though
      // "credit card" doesn't appear in the title
      const results = await memory.recall("credit card transactions");

      expect(results.length).toBeGreaterThanOrEqual(1);
      const titles = results.map((r) => r.title);
      expect(titles.some((t) => t.includes("Stripe"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "hybrid search ranks memories found by both methods higher",
    async () => {
      // Memory that matches both keyword and semantic
      memory.save({
        category: "decision",
        title: "Use PostgreSQL for the database",
        body: "PostgreSQL is our primary database for data storage.",
        tags: ["database", "postgres"],
      });

      // Memory that matches semantically but not by keyword
      memory.save({
        category: "decision",
        title: "Use Elasticsearch for log search",
        body: "Elasticsearch for searching and analyzing log data.",
        tags: ["search", "logs"],
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // "database" matches PostgreSQL by keyword AND semantic
      // "database" matches Elasticsearch only by semantic (data storage concept)
      const results = await memory.recall("database");

      expect(results.length).toBeGreaterThanOrEqual(1);
      // PostgreSQL should rank first (found by both methods)
      expect(results[0]?.title).toContain("PostgreSQL");
    },
    TEST_TIMEOUT,
  );

  it(
    "auto-embeds on save (embedding stored in DB)",
    async () => {
      const id = memory.save({
        category: "decision",
        title: "Use Docker for containerization",
        body: "All services run in Docker containers.",
        tags: ["docker", "containers"],
      });

      // Wait for async embedding
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify embedding was stored
      const embBuf = store.getMemoryEmbedding(id);
      expect(embBuf).not.toBeNull();
      expect(embBuf!.length).toBe(EMBEDDING_DIM * 4);

      const emb = bufferToEmbedding(embBuf);
      expect(emb).not.toBeNull();
      expect(emb!.length).toBe(EMBEDDING_DIM);
    },
    TEST_TIMEOUT,
  );

  it(
    "backfills embeddings for pre-existing memories on first recall",
    async () => {
      // Insert a memory directly into the DB (bypassing AgentMemory.save)
      // so it has no embedding
      store.db
        .prepare(
          `INSERT INTO memories (timestamp,category,title,body,tags_json,source,confidence,status,evidence_json)
           VALUES (?,?,?,?,?,?,1.0,'active','[]')`,
        )
        .run(
          new Date().toISOString(),
          "decision",
          "Use GraphQL for API",
          "GraphQL provides a flexible query language for our API.",
          JSON.stringify(["api", "graphql"]),
          null,
        );

      // Also insert into FTS
      const id = store.db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number };
      store.db
        .prepare("INSERT INTO memories_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)")
        .run(id.id, "Use GraphQL for API", "GraphQL provides a flexible query language for our API.", JSON.stringify(["api", "graphql"]));

      // No embedding yet
      expect(store.getMemoryEmbedding(id.id)).toBeNull();

      // Trigger recall — this should backfill the embedding
      await memory.recall("GraphQL");

      // Wait for backfill
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Embedding should now exist
      const emb = store.getMemoryEmbedding(id.id);
      expect(emb).not.toBeNull();
    },
    TEST_TIMEOUT,
  );
});

// FTS5 fallback tests — run in all modes
describe("AgentMemory — FTS5 fallback (always runs)", () => {
  it("recall works with FTS5 when embeddings are disabled", async () => {
    memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "We chose Stripe over PayPal for payment processing.",
      tags: ["payments", "billing"],
    });

    const results = await memory.recall("Stripe payments");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.title).toContain("Stripe");
  });

  it("recall returns empty array for no matches", async () => {
    memory.save({
      category: "decision",
      title: "Use React for frontend",
      body: "React with TypeScript.",
      tags: ["frontend"],
    });

    const results = await memory.recall("quantum physics");
    expect(results.length).toBe(0);
  });

  it("recall handles empty query by listing recent memories", async () => {
    memory.save({
      category: "decision",
      title: "Test memory 1",
      body: "Body 1.",
      tags: [],
    });
    memory.save({
      category: "decision",
      title: "Test memory 2",
      body: "Body 2.",
      tags: [],
    });

    const results = await memory.recall("");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("store embedding methods work correctly", () => {
    const id = memory.save({
      category: "decision",
      title: "Embedding storage test",
      body: "Testing embedding storage.",
      tags: ["test"],
    });

    // Initially no embedding (async generation hasn't completed yet)
    const initial = store.getMemoryEmbedding(id);
    // Might be null or might have been set already (race condition in async)
    // Just verify the method doesn't crash

    // Manually set an embedding
    const testEmb = new Float32Array(EMBEDDING_DIM).fill(0.5);
    store.setMemoryEmbedding(id, embeddingToBuffer(testEmb));

    // Verify it was stored
    const retrieved = store.getMemoryEmbedding(id);
    expect(retrieved).not.toBeNull();
    const restored = bufferToEmbedding(retrieved);
    expect(restored).not.toBeNull();
    expect(restored![0]).toBeCloseTo(0.5, 5);
  });

  it("allMemoryEmbeddings returns only memories with embeddings", () => {
    const id1 = memory.save({
      category: "decision",
      title: "Memory with embedding",
      body: "This one has an embedding.",
      tags: ["test"],
    });
    const id2 = memory.save({
      category: "decision",
      title: "Memory without embedding",
      body: "This one does not.",
      tags: ["test"],
    });

    // Set embedding on id1 only
    const testEmb = new Float32Array(EMBEDDING_DIM).fill(0.3);
    store.setMemoryEmbedding(id1, embeddingToBuffer(testEmb));

    // Don't set embedding on id2

    const all = store.allMemoryEmbeddings();
    const ids = all.map((e) => e.id);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });

  it("countEmbeddedMemories returns correct count", () => {
    const id1 = memory.save({
      category: "decision",
      title: "Count test 1",
      body: "Body.",
      tags: [],
    });
    memory.save({
      category: "decision",
      title: "Count test 2",
      body: "Body.",
      tags: [],
    });

    // Set embedding on id1
    store.setMemoryEmbedding(id1, embeddingToBuffer(new Float32Array(EMBEDDING_DIM).fill(0.1)));

    const count = store.countEmbeddedMemories();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

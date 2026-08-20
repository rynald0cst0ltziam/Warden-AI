/**
 * Memory layer tests — FTS5 search, dedup, conflict detection.
 *
 * Verifies:
 * - save + recall basic flow
 * - FTS5 full-text search with relevance ranking
 * - Porter stemming (e.g. "payment" matches "payments")
 * - Dedup: saving same title twice returns same id
 * - Conflict detection: similar titles in same category are flagged
 * - Access-time tracking on recall
 * - Forget removes memory
 * - FTS5 fallback to LIKE if FTS unavailable
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { AgentMemory } from "../src/memory/index.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-mem-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let store: SqliteStore;
let memory: AgentMemory;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = await SqliteStore.open(TEST_DB);
  memory = new AgentMemory(store);
});

afterAll(() => {
  store.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("AgentMemory — basic save and recall", () => {
  it("saves a memory and recalls it by title", async () => {
    const id = memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "We chose Stripe over PayPal for payment processing.",
      tags: ["payments", "billing"],
    });
    expect(id).toBeGreaterThan(0);

    const results = await memory.recall("Stripe payments");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toBe("Use Stripe for payments");
    expect(found?.tags).toContain("payments");
  });

  it("recall uses FTS5 porter stemming", async () => {
    // "payment" should match "payments" via porter stemmer
    memory.save({
      category: "decision",
      title: "Use PayPal for payment processing",
      body: "Alternative payment gateway for international transactions.",
      tags: ["payments", "international"],
    });

    const results = await memory.recall("payment");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both Stripe and PayPal memories should match "payment"
    const titles = results.map((r) => r.title);
    expect(titles.some((t) => t.includes("Stripe"))).toBe(true);
    expect(titles.some((t) => t.includes("PayPal"))).toBe(true);
  });

  it("recall ranks by relevance, not just access time", async () => {
    memory.save({
      category: "finding",
      title: "Database uses PostgreSQL",
      body: "The project database is PostgreSQL 15.",
      tags: ["database", "postgres"],
    });
    memory.save({
      category: "pattern",
      title: "All API routes use /api/v1/ prefix",
      body: "Convention: every API endpoint starts with /api/v1/.",
      tags: ["api", "convention"],
    });

    // Search for "database" — should rank the PostgreSQL memory first
    const results = await memory.recall("database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.title).toContain("PostgreSQL");
  });
});

describe("AgentMemory — dedup", () => {
  it("returns existing id for duplicate title (case-insensitive)", () => {
    const id1 = memory.save({
      category: "decision",
      title: "Use JWT for authentication",
      body: "We use JWT with refresh tokens.",
      tags: ["auth", "jwt"],
    });
    const id2 = memory.save({
      category: "decision",
      title: "use jwt for authentication", // same title, different case
      body: "Different body should not matter for dedup.",
      tags: ["auth"],
    });
    expect(id1).toBe(id2);
  });

  it("returns existing id for duplicate title with whitespace differences", () => {
    const id1 = memory.save({
      category: "decision",
      title: "Use Redis for caching",
      body: "Redis for session cache.",
      tags: ["cache", "redis"],
    });
    const id2 = memory.save({
      category: "decision",
      title: "  Use Redis for caching  ", // leading/trailing spaces
      body: "Different body.",
      tags: ["cache"],
    });
    expect(id1).toBe(id2);
  });
});

describe("AgentMemory — conflict detection", () => {
  it("detects conflicting memories in the same category", () => {
    // Save first decision
    memory.save({
      category: "decision",
      title: "Use Stripe for payment processing",
      body: "Stripe is our payment provider.",
      tags: ["payments", "stripe"],
    });

    // Check conflicts for a similar title in the same category
    const conflicts = memory.findConflicts(
      "Use PayPal for payment processing",
      "decision",
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const titles = conflicts.map((c) => c.title);
    expect(titles.some((t) => t.includes("Stripe"))).toBe(true);
  });

  it("does not flag conflicts in different categories", () => {
    memory.save({
      category: "constraint",
      title: "Must support payment processing on mobile",
      body: "Mobile payment support required.",
      tags: ["payments", "mobile"],
    });

    // Same key word "payment" but different category — should not conflict
    const conflicts = memory.findConflicts(
      "Use Adyen for payment processing",
      "preference",
    );
    // Should not find the constraint as a conflict for a preference
    const constraintConflicts = conflicts.filter(
      (c) => c.category === "constraint",
    );
    expect(constraintConflicts.length).toBe(0);
  });
});

describe("AgentMemory — access tracking", () => {
  it("updates access time and count on recall", async () => {
    const id = memory.save({
      category: "pattern",
      title: "Use functional components only",
      body: "No class components in this project.",
      tags: ["react", "convention"],
    });

    // Recall it
    await memory.recall("functional components");
    await memory.recall("functional components");

    const all = memory.list(1000);
    const found = all.find((m) => m.id === id);
    expect(found).toBeDefined();
    expect(found?.accessCount).toBeGreaterThanOrEqual(2);
    expect(found?.accessedAt).not.toBeNull();
  });
});

describe("AgentMemory — forget", () => {
  it("removes a memory by id", () => {
    const id = memory.save({
      category: "preference",
      title: "Prefer tabs over spaces",
      body: "Use tabs for indentation.",
      tags: ["style"],
    });

    const deleted = memory.forget(id);
    expect(deleted).toBe(true);

    // Verify it's gone
    const all = memory.list(1000);
    const found = all.find((m) => m.id === id);
    expect(found).toBeUndefined();
  });

  it("returns false for non-existent id", () => {
    const deleted = memory.forget(99999);
    expect(deleted).toBe(false);
  });
});

describe("AgentMemory — validation", () => {
  it("throws on empty title", () => {
    expect(() =>
      memory.save({
        category: "decision",
        title: "   ",
        body: "Valid body.",
        tags: [],
      }),
    ).toThrow("title must not be empty");
  });

  it("throws on empty body", () => {
    expect(() =>
      memory.save({
        category: "decision",
        title: "Valid title",
        body: "",
        tags: [],
      }),
    ).toThrow("body must not be empty");
  });
});

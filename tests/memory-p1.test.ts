/**
 * P1 Memory Evolution tests — structured decisions, lifecycle, provenance,
 * failed approaches.
 *
 * Tests:
 * - Save with structured provenance (sourceType, evidence, scope)
 * - Save with outcome='failure' for failed approach tracking
 * - Decision lifecycle: reaffirm, supersede, archive, markContested, reject
 * - findFailedApproaches returns matching failures
 * - Supersede links old to new and marks old as superseded
 * - Dedup only matches active memories (superseded can be re-created)
 * - toResult includes all P1 fields
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { AgentMemory } from "../src/memory/index.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-mem-p1-test-${Date.now()}`);
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

beforeEach(() => {
  store.db.exec("DELETE FROM memories");
  // Also clean FTS
  try {
    store.db.exec("DELETE FROM memories_fts");
  } catch {
    // FTS might not exist
  }
});

describe("P1: Structured provenance", () => {
  it("saves a memory with sourceType, evidence, and scope", () => {
    const id = memory.save({
      category: "decision",
      title: "Use PostgreSQL for order storage",
      body: "PostgreSQL is the authoritative order store.",
      tags: ["database", "orders"],
      sourceType: "documentation",
      evidence: ["docs/architecture.md", "commit 82ac19"],
      scope: "order-service",
    });

    const results = memory.recall("PostgreSQL");
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.sourceType).toBe("documentation");
    expect(found!.evidence).toContain("docs/architecture.md");
    expect(found!.evidence).toContain("commit 82ac19");
    expect(found!.scope).toBe("order-service");
    expect(found!.status).toBe("active");
  });

  it("saves a memory without P1 fields (backward compatible)", () => {
    const id = memory.save({
      category: "decision",
      title: "Use JWT for auth",
      body: "JWT with refresh tokens.",
      tags: ["auth"],
    });

    const results = memory.recall("JWT");
    const found = results.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.sourceType).toBeNull();
    expect(found!.evidence).toEqual([]);
    expect(found!.scope).toBeNull();
    expect(found!.outcome).toBeNull();
    expect(found!.status).toBe("active");
  });
});

describe("P1: Failed approach memory", () => {
  it("saves a failed approach with outcome='failure'", () => {
    const id = memory.save({
      category: "failed_approach",
      title: "Redis-backed sessions",
      body: "Deployment environment loses persistence. Do not retry.",
      tags: ["sessions", "redis"],
      outcome: "failure",
      sourceType: "code",
      evidence: ["commit 83ac21", "session log #912"],
    });

    expect(id).toBeGreaterThan(0);

    const failed = memory.findFailedApproaches("Redis sessions");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const found = failed.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.outcome).toBe("failure");
    expect(found!.category).toBe("failed_approach");
  });

  it("findFailedApproaches returns only failures, not successes", () => {
    memory.save({
      category: "decision",
      title: "Use PostgreSQL for sessions",
      body: "PostgreSQL-backed sessions work reliably.",
      tags: ["sessions", "postgres"],
      outcome: "success",
    });

    memory.save({
      category: "failed_approach",
      title: "Redis-backed sessions",
      body: "Deployment environment loses persistence.",
      tags: ["sessions", "redis"],
      outcome: "failure",
    });

    const failed = memory.findFailedApproaches("sessions");
    expect(failed.length).toBe(1);
    expect(failed[0].title).toBe("Redis-backed sessions");
    expect(failed[0].outcome).toBe("failure");
  });

  it("findFailedApproaches with empty query returns all failures", () => {
    memory.save({
      category: "failed_approach",
      title: "Approach A",
      body: "Failed for reason A.",
      tags: ["test"],
      outcome: "failure",
    });

    memory.save({
      category: "failed_approach",
      title: "Approach B",
      body: "Failed for reason B.",
      tags: ["test"],
      outcome: "failure",
    });

    const failed = memory.findFailedApproaches("");
    expect(failed.length).toBe(2);
  });
});

describe("P1: Decision lifecycle", () => {
  it("reaffirm increments count and updates timestamp", () => {
    const id = memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "Stripe is the payment processor.",
      tags: ["payments"],
    });

    const ok = memory.reaffirm(id);
    expect(ok).toBe(true);

    // Verify by recalling
    const results = memory.recall("Stripe");
    const found = results.find((r) => r.id === id);
    expect(found!.reaffirmedCount).toBe(1);
    expect(found!.lastReaffirmedAt).not.toBeNull();
  });

  it("supersede marks old as superseded and links to new", () => {
    const oldId = memory.save({
      category: "decision",
      title: "Use PayPal for payments",
      body: "PayPal is the payment processor.",
      tags: ["payments"],
    });

    // Saving with supersedesId auto-supersedes the old decision
    const newId = memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "Stripe is the payment processor, replacing PayPal.",
      tags: ["payments"],
      supersedesId: oldId,
    });

    // Verify old is superseded (auto-superseded by save)
    const oldResults = memory.recall("PayPal");
    const oldFound = oldResults.find((r) => r.id === oldId);
    expect(oldFound!.status).toBe("superseded");
    expect(oldFound!.supersedesId).toBe(newId);

    // Verify new is active
    const newResults = memory.recall("Stripe");
    const newFound = newResults.find((r) => r.id === newId);
    expect(newFound!.status).toBe("active");
    expect(newFound!.supersedesId).toBe(oldId);
  });

  it("explicit supersede() also works for manual lifecycle", () => {
    const oldId = memory.save({
      category: "decision",
      title: "Use MongoDB for logs",
      body: "MongoDB for log storage.",
      tags: ["logs"],
    });

    const newId = memory.save({
      category: "decision",
      title: "Use Elasticsearch for logs",
      body: "Elasticsearch for log storage, replacing MongoDB.",
      tags: ["logs"],
      // No supersedesId — will supersede manually
    });

    // Manually supersede
    const ok = memory.supersede(oldId, newId);
    expect(ok).toBe(true);

    const oldResults = memory.recall("MongoDB");
    const oldFound = oldResults.find((r) => r.id === oldId);
    expect(oldFound!.status).toBe("superseded");
    expect(oldFound!.supersedesId).toBe(newId);
  });

  it("archive sets status to expired", () => {
    const id = memory.save({
      category: "decision",
      title: "Old architecture decision",
      body: "No longer relevant.",
      tags: ["old"],
    });

    const ok = memory.archive(id);
    expect(ok).toBe(true);

    const results = memory.list();
    const found = results.find((r) => r.id === id);
    expect(found!.status).toBe("expired");
  });

  it("markContested sets status to contested", () => {
    const id = memory.save({
      category: "decision",
      title: "Use MongoDB",
      body: "Maybe MongoDB for everything.",
      tags: ["database"],
    });

    const ok = memory.markContested(id);
    expect(ok).toBe(true);

    const results = memory.list();
    const found = results.find((r) => r.id === id);
    expect(found!.status).toBe("contested");
  });

  it("reject sets status to rejected", () => {
    const id = memory.save({
      category: "decision",
      title: "Bad idea",
      body: "This was a bad idea.",
      tags: ["bad"],
    });

    const ok = memory.reject(id);
    expect(ok).toBe(true);

    const results = memory.list();
    const found = results.find((r) => r.id === id);
    expect(found!.status).toBe("rejected");
  });

  it("lifecycle methods return false for non-existent or non-active memories", () => {
    expect(memory.reaffirm(99999)).toBe(false);
    expect(memory.archive(99999)).toBe(false);
    expect(memory.markContested(99999)).toBe(false);
    expect(memory.reject(99999)).toBe(false);
  });
});

describe("P1: Dedup respects status", () => {
  it("allows re-creating a superseded decision with same title", () => {
    const oldId = memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "Original decision.",
      tags: ["payments"],
    });

    // Supersede it (auto-supersedes via supersedesId)
    const newId = memory.save({
      category: "decision",
      title: "Use Adyen for payments",
      body: "Switching to Adyen.",
      tags: ["payments"],
      supersedesId: oldId,
    });

    // Now we can create a new decision with the same title as the old one
    const reCreatedId = memory.save({
      category: "decision",
      title: "Use Stripe for payments",
      body: "Bringing Stripe back for a different scope.",
      tags: ["payments"],
      scope: "checkout-only",
    });

    // Should be a new ID, not the old one
    expect(reCreatedId).not.toBe(oldId);
    expect(reCreatedId).toBeGreaterThan(0);
  });
});

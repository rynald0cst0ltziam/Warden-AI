/**
 * CCR (Compress-Cache-Retrieve) tests.
 *
 * Verifies:
 * - Hash generation is deterministic and 12 chars
 * - storeOriginal stores when pruning removed content
 * - storeOriginal returns null when no pruning happened
 * - retrieveOriginal returns the original by hash
 * - retrieveOriginal returns null for unknown hash
 * - extractCcrMarker finds the hash in pruned output
 * - appendCcrMarker adds the marker correctly
 * - ccrCleanup removes old entries
 * - Full pipeline: prune → CCR marker in output → retrieve → get original
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import {
  ccrHash,
  storeOriginal,
  retrieveOriginal,
  extractCcrMarker,
  appendCcrMarker,
  ccrCleanup,
  ccrSummary,
} from "../src/ccr/index.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-ccr-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let store: SqliteStore;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = await SqliteStore.open(TEST_DB);
});

afterAll(() => {
  store.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("CCR — hash generation", () => {
  it("generates a 12-char hex hash", () => {
    const hash = ccrHash("hello world");
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("is deterministic — same input → same hash", () => {
    const h1 = ccrHash("test output");
    const h2 = ccrHash("test output");
    expect(h1).toBe(h2);
  });

  it("different inputs → different hashes", () => {
    const h1 = ccrHash("output A");
    const h2 = ccrHash("output B");
    expect(h1).not.toBe(h2);
  });
});

describe("CCR — storeOriginal", () => {
  it("stores original and returns marker when pruning removed content", () => {
    const marker = storeOriginal({
      store,
      rawOutput: "line 1\nline 2\nline 3\nline 4\nline 5",
      toolType: "grep",
      ruleId: "test.rule.v1",
      tokensFull: 100,
      tokensPruned: 30,
    });
    expect(marker).not.toBeNull();
    expect(marker).toContain("warden_retrieve");
    expect(marker).toContain("‹warden›");
  });

  it("returns null when no pruning happened (tokensPruned >= tokensFull)", () => {
    const marker = storeOriginal({
      store,
      rawOutput: "small output",
      toolType: "generic",
      ruleId: "test.rule.v1",
      tokensFull: 10,
      tokensPruned: 10,
    });
    expect(marker).toBeNull();
  });

  it("returns null when pruning increased size (edge case)", () => {
    const marker = storeOriginal({
      store,
      rawOutput: "edge case",
      toolType: "generic",
      ruleId: "test.rule.v1",
      tokensFull: 5,
      tokensPruned: 8,
    });
    expect(marker).toBeNull();
  });
});

describe("CCR — retrieveOriginal", () => {
  it("retrieves the original by hash", () => {
    const raw = "original content for retrieval test";
    const marker = storeOriginal({
      store,
      rawOutput: raw,
      toolType: "grep",
      ruleId: "test.rule.v1",
      tokensFull: 50,
      tokensPruned: 10,
    });
    expect(marker).not.toBeNull();

    // Extract hash from marker
    const hash = extractCcrMarker(marker!);
    expect(hash).not.toBeNull();

    const retrieved = retrieveOriginal(store, hash!);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.rawOutput).toBe(raw);
    expect(retrieved!.toolType).toBe("grep");
    expect(retrieved!.tokensFull).toBe(50);
  });

  it("returns null for unknown hash", () => {
    const retrieved = retrieveOriginal(store, "nonexistent");
    expect(retrieved).toBeNull();
  });
});

describe("CCR — extractCcrMarker", () => {
  it("extracts hash from a pruned output with marker", () => {
    const output = `pruned line 1\npruned line 2\n‹warden› retrieve full output: warden_retrieve("abc123def456")`;
    const hash = extractCcrMarker(output);
    expect(hash).toBe("abc123def456");
  });

  it("returns null when no marker present", () => {
    const output = "just some output\nno marker here";
    const hash = extractCcrMarker(output);
    expect(hash).toBeNull();
  });

  it("handles marker in the middle of output", () => {
    const output = `line 1\n‹warden› retrieve full output: warden_retrieve("aabbccddeeff")\nline 3`;
    const hash = extractCcrMarker(output);
    expect(hash).toBe("aabbccddeeff");
  });
});

describe("CCR — appendCcrMarker", () => {
  it("appends marker to pruned output", () => {
    const pruned = "pruned content";
    const marker = '‹warden› retrieve full output: warden_retrieve("abc123")';
    const result = appendCcrMarker(pruned, marker);
    expect(result).toContain(pruned);
    expect(result).toContain(marker);
    expect(result).toBe("pruned content\n" + marker);
  });

  it("returns unchanged output when marker is null", () => {
    const pruned = "pruned content";
    const result = appendCcrMarker(pruned, null);
    expect(result).toBe(pruned);
  });
});

describe("CCR — cleanup and summary", () => {
  it("ccrSummary returns count and tokens saved", () => {
    const summary = ccrSummary(store);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.tokensSaved).toBeGreaterThan(0);
  });

  it("ccrCleanup removes entries older than TTL", () => {
    // Insert an old entry manually by backdating the timestamp
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    store.saveCcr({
      hash: "oldtesthash1",
      rawOutput: "old content",
      toolType: "generic",
      ruleId: "test.v1",
      tokensFull: 100,
      tokensPruned: 50,
    });
    // Manually backdate it
    store.db
      .prepare("UPDATE ccr_cache SET created_at = ? WHERE hash = ?")
      .run(oldDate.toISOString(), "oldtesthash1");

    const removed = ccrCleanup(store, 7);
    expect(removed).toBeGreaterThanOrEqual(1);

    // Verify it's gone
    const row = store.getCcr("oldtesthash1");
    expect(row).toBeUndefined();
  });
});

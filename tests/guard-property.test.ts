/**
 * Property-based tests for the trust guard.
 *
 * These test invariants that should hold for ANY input, not just specific
 * cases. We use random generation to explore edge cases.
 *
 * Properties tested:
 * 1. verifyInclusion(raw, raw) === true  (identity)
 * 2. verifyInclusion(raw, "") === true   (empty subset)
 * 3. verifyInclusion(raw, subset) === true  (any subset of lines)
 * 4. verifyInclusion(raw, altered) === false  (any altered line fails)
 * 5. verifyInclusion(raw, raw + annotation) === true  (annotations ok)
 * 6. verifyInclusion is reflexive for any string
 */
import { describe, it, expect } from "vitest";
import { verifyInclusion, annotation } from "../src/pruner/guard.js";

// Simple PRNG for deterministic tests
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function randomString(rng: () => number, maxLen = 50): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789 .,:;[]{}()<>/\\'\"-_=+*";
  const len = Math.floor(rng() * maxLen) + 1;
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

function randomLines(rng: () => number, count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(randomString(rng, 30));
  }
  return lines;
}

describe("guard property-based tests", () => {
  it("identity: verifyInclusion(x, x) === true for any x", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 200; i++) {
      const lines = randomLines(rng, Math.floor(rng() * 20) + 1);
      const text = lines.join("\n");
      expect(verifyInclusion(text, text)).toBe(true);
    }
  });

  it("empty subset: verifyInclusion(x, '') === true for any x", () => {
    const rng = makeRng(123);
    for (let i = 0; i < 200; i++) {
      const lines = randomLines(rng, Math.floor(rng() * 20) + 1);
      const text = lines.join("\n");
      expect(verifyInclusion(text, "")).toBe(true);
    }
  });

  it("any subset of lines passes", () => {
    const rng = makeRng(999);
    for (let i = 0; i < 200; i++) {
      const lines = randomLines(rng, Math.floor(rng() * 30) + 5);
      const text = lines.join("\n");
      // Pick a random subset of lines
      const subset = lines.filter(() => rng() > 0.5);
      if (subset.length === 0) continue; // empty subset always passes
      expect(verifyInclusion(text, subset.join("\n"))).toBe(true);
    }
  });

  it("any altered line fails", () => {
    const rng = makeRng(777);
    for (let i = 0; i < 200; i++) {
      const lines = randomLines(rng, Math.floor(rng() * 10) + 2);
      const text = lines.join("\n");
      // Take a subset and alter one line
      const subset = [...lines.filter(() => rng() > 0.3)];
      if (subset.length === 0) continue;
      const alterIdx = Math.floor(rng() * subset.length);
      subset[alterIdx] = subset[alterIdx]! + "X"; // append a char
      // Only test if the altered line is NOT in the original (avoid collisions)
      if (!text.includes(subset[alterIdx]!)) {
        expect(verifyInclusion(text, subset.join("\n"))).toBe(false);
      }
    }
  });

  it("annotations are always allowed", () => {
    const rng = makeRng(555);
    for (let i = 0; i < 100; i++) {
      const lines = randomLines(rng, Math.floor(rng() * 10) + 1);
      const text = lines.join("\n");
      const withAnnotation = text + "\n" + annotation("some collapse note");
      expect(verifyInclusion(text, withAnnotation)).toBe(true);
    }
  });

  it("duplicate lines in raw are handled correctly", () => {
    const rng = makeRng(333);
    for (let i = 0; i < 100; i++) {
      // Create lines with duplicates
      const base = randomLines(rng, 3);
      const lines = [...base, ...base, ...base];
      const text = lines.join("\n");
      const subset = [base[0]!].join("\n");
      expect(verifyInclusion(text, subset)).toBe(true);
    }
  });

  it("lines with only whitespace differences pass (trailing ws ignored)", () => {
    const rng = makeRng(888);
    for (let i = 0; i < 100; i++) {
      const line = randomString(rng, 20);
      const raw = line + "   \t";
      const pruned = line;
      expect(verifyInclusion(raw, pruned)).toBe(true);
    }
  });

  it("very long inputs don't cause issues", () => {
    const rng = makeRng(111);
    const lines = randomLines(rng, 5000);
    const text = lines.join("\n");
    // Identity
    expect(verifyInclusion(text, text)).toBe(true);
    // Random subset
    const subset = lines.filter(() => rng() > 0.7);
    expect(verifyInclusion(text, subset.join("\n"))).toBe(true);
  });
});

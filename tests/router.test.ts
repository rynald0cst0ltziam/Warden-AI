/**
 * Content-aware router tests.
 *
 * Verifies:
 * - JSON detection (valid JSON, JSON-like structure)
 * - grep output detection (path:line:content pattern)
 * - test log detection (test framework markers)
 * - source code detection (import/function/class patterns)
 * - generic fallback for unrecognized content
 * - small output fast-path
 * - mixed content section splitting
 */
import { describe, it, expect } from "vitest";
import { routeContent, routeMixedContent } from "../src/pruner/router.js";

describe("Content-aware router — JSON detection", () => {
  it("detects valid JSON object", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) obj[`key${i}`] = { id: i, name: `item${i}` };
    const raw = JSON.stringify(obj, null, 2);
    const result = routeContent(raw);
    expect(result.toolType).toBe("json");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("detects valid JSON array", () => {
    const raw = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item${i}` })),
      null,
      2,
    );
    const result = routeContent(raw);
    expect(result.toolType).toBe("json");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("detects JSON-like structure (not valid JSON but JSON patterns)", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `  { "id": ${i}, "name": "item${i}" },`,
    );
    const raw = lines.join("\n");
    const result = routeContent(raw);
    expect(result.toolType).toBe("json");
  });
});

describe("Content-aware router — grep detection", () => {
  it("detects grep output (path:line:content)", () => {
    const lines = [
      "src/auth.ts:42:export function login(user: string) {",
      "src/auth.ts:43:  const token = signJWT(user);",
      "src/auth.ts:44:  return token;",
      "src/utils.ts:8:export function helper() {",
      "src/utils.ts:9:  return true;",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("grep");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("detects Windows-style grep output", () => {
    const lines = [
      "C:\\src\\auth.ts:42:export function login(user: string) {",
      "C:\\src\\auth.ts:43:  const token = signJWT(user);",
      "C:\\src\\auth.ts:44:  return token;",
      "C:\\src\\auth.ts:45:}",
      "C:\\src\\utils.ts:8:export function helper() {",
      "C:\\src\\utils.ts:9:  return true;",
      "C:\\src\\utils.ts:10:}",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("grep");
  });
});

describe("Content-aware router — test log detection", () => {
  it("detects vitest output", () => {
    const lines = [
      "RUN  v3.2.1",
      "",
      " ✓ src/test/auth.test.ts (3 tests) 12ms",
      " ✓ src/test/utils.test.ts (5 tests) 8ms",
      " ✗ src/test/api.test.ts (2 tests) 15ms",
      "",
      " Test Files  3 (2 passed, 1 failed)",
      " Tests  10 (8 passed, 2 failed)",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("test-log");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("detects pytest output", () => {
    const lines = [
      "============================= test session starts ==============================",
      "platform darwin -- Python 3.12.0, pytest-7.4.0, plasm-0.1.3",
      "rootdir: /home/user/project",
      "collected 15 items",
      "",
      "tests/test_auth.py::test_login PASSED    [  6%]",
      "tests/test_auth.py::test_logout PASSED    [ 13%]",
      "tests/test_auth.py::test_invalid FAILED  [ 20%]",
      "tests/test_utils.py::test_helper PASSED  [ 26%]",
      "tests/test_utils.py::test_parse FAILED   [ 33%]",
      "",
      "========================= 2 failed, 3 passed in 0.5s ==========================",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("test-log");
  });
});

describe("Content-aware router — source code detection", () => {
  it("detects TypeScript source code", () => {
    const lines = [
      'import { createSignal } from "solid-js";',
      "",
      "export function Counter() {",
      "  const [count, setCount] = createSignal(0);",
      "  return (",
      "    <button onClick={() => setCount(count() + 1)}>",
      "      {count()}",
      "    </button>",
      "  );",
      "}",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("file-read");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("detects Python source code", () => {
    const lines = [
      "from typing import List, Optional",
      "import os",
      "import sys",
      "",
      "def process_items(items: List[str]) -> Optional[str]:",
      "    if not items:",
      "        return None",
      "    return items[0]",
      "",
      "class ItemProcessor:",
      "    def __init__(self):",
      "        self.items = []",
      "",
      "    def add(self, item: str) -> None:",
      "        self.items.append(item)",
    ];
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("file-read");
  });
});

describe("Content-aware router — generic fallback", () => {
  it("falls back to generic for unrecognized content", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `some random text ${i} with no particular pattern`,
    );
    const result = routeContent(lines.join("\n"));
    expect(result.toolType).toBe("generic");
  });

  it("uses generic fast-path for small outputs (<5 lines)", () => {
    const result = routeContent("just\nthree\nlines");
    expect(result.toolType).toBe("generic");
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toContain("small output");
  });
});

describe("Content-aware router — mixed content", () => {
  it("splits mixed content into sections", () => {
    const grepSection = [
      "src/auth.ts:42:export function login(user: string) {",
      "src/auth.ts:43:  const token = signJWT(user);",
      "src/auth.ts:44:  return token;",
    ].join("\n");

    const testSection = [
      "RUN  v3.2.1",
      " ✓ src/test/auth.test.ts (3 tests) 12ms",
      " ✗ src/test/api.test.ts (2 tests) 15ms",
      " Test Files  2 (1 passed, 1 failed)",
      " Tests  5 (3 passed, 2 failed)",
    ].join("\n");

    const mixed = grepSection + "\n\n\n" + testSection;
    const result = routeMixedContent(mixed);
    expect(result.sections.length).toBe(2);
    expect(result.sections[0]!.toolType).toBe("grep");
    expect(result.sections[1]!.toolType).toBe("test-log");
  });
});

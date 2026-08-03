/**
 * Preprocessing pipeline tests — ANSI stripping, path shortening, JSON
 * cleanup, whitespace normalization, and command rewrites.
 */
import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  shortenPaths,
  cleanJson,
  normalizeWhitespace,
  rewriteCommand,
  preprocessOutput,
} from "../src/pruner/preprocess.js";

describe("stripAnsi", () => {
  it("removes basic color codes", () => {
    expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("removes bold and multiple styles", () => {
    expect(stripAnsi("\x1b[1;32mbold green\x1b[0m")).toBe("bold green");
  });

  it("removes cursor movement codes", () => {
    expect(stripAnsi("\x1b[2Atext\x1b[0G")).toBe("text");
  });

  it("removes OSC sequences (terminal title)", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("removes OSC sequences with ST terminator", () => {
    expect(stripAnsi("\x1b]0;title\x1b\\text")).toBe("text");
  });

  it("preserves non-ANSI text", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("removes bare carriage returns from progress bars", () => {
    expect(stripAnsi("loading...\rdone")).toBe("loading...done");
  });

  it("preserves Windows line endings", () => {
    expect(stripAnsi("line1\r\nline2")).toBe("line1\r\nline2");
  });
});

describe("shortenPaths", () => {
  it("shortens Unix paths to relative", () => {
    const input =
      "/Users/alice/myproject/src/main.ts:42: Error\n/Users/alice/myproject/src/utils.ts:10: Warn";
    const result = shortenPaths(input);
    expect(result).not.toContain("/Users/alice/myproject/");
    expect(result).toContain("main.ts:42: Error");
    expect(result).toContain("utils.ts:10: Warn");
  });

  it("shortens Windows paths to relative", () => {
    const input =
      "C:\\Users\\alice\\myproject\\src\\main.ts:42: Error\nC:\\Users\\alice\\myproject\\src\\utils.ts:10: Warn";
    const result = shortenPaths(input);
    expect(result).not.toContain("C:\\Users\\alice\\myproject\\");
  });

  it("returns unchanged if only one path", () => {
    const input = "/Users/alice/myproject/src/main.ts:42: Error";
    expect(shortenPaths(input)).toBe(input);
  });

  it("returns unchanged if no paths", () => {
    expect(shortenPaths("just some text")).toBe("just some text");
  });
});

describe("cleanJson", () => {
  it("removes null values", () => {
    const input = JSON.stringify({ a: 1, b: null, c: "text" });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({ a: 1, c: "text" });
  });

  it("removes empty arrays and objects", () => {
    const input = JSON.stringify({ a: 1, b: [], c: {}, d: "text" });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({ a: 1, d: "text" });
  });

  it("removes false values but keeps true", () => {
    const input = JSON.stringify({
      active: true,
      inactive: false,
      name: "test",
    });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({ active: true, name: "test" });
  });

  it("removes empty strings", () => {
    const input = JSON.stringify({ a: "", b: "text" });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({ b: "text" });
  });

  it("keeps zero (0 is informative)", () => {
    const input = JSON.stringify({ count: 0, name: "test" });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({ count: 0, name: "test" });
  });

  it("recursively cleans nested objects", () => {
    const input = JSON.stringify({
      outer: { inner: null, keep: "yes" },
      data: [
        { id: 1, value: null },
        { id: 2, value: "hello" },
      ],
    });
    const result = JSON.parse(cleanJson(input));
    expect(result).toEqual({
      outer: { keep: "yes" },
      data: [{ id: 1 }, { id: 2, value: "hello" }],
    });
  });

  it("returns unchanged for non-JSON input", () => {
    expect(cleanJson("not json at all")).toBe("not json at all");
  });

  it("returns unchanged if cleanup would grow output", () => {
    const input = '{"a":1}';
    expect(cleanJson(input)).toBe('{"a":1}');
  });
});

describe("normalizeWhitespace", () => {
  it("collapses 3+ blank lines to 1", () => {
    expect(normalizeWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims trailing whitespace per line", () => {
    expect(normalizeWhitespace("a   \nb\t\n")).toBe("a\nb\n");
  });

  it("removes leading blank lines", () => {
    expect(normalizeWhitespace("\n\n\na")).toBe("a");
  });

  it("removes trailing blank lines but keeps final newline", () => {
    expect(normalizeWhitespace("a\n\n\n")).toBe("a\n");
  });
});

describe("rewriteCommand", () => {
  it("adds --silent to npm install", () => {
    expect(rewriteCommand("npm install")).toBe("npm install --silent");
  });

  it("adds --silent to npm test", () => {
    expect(rewriteCommand("npm test")).toBe("npm test --silent");
  });

  it("adds --no-color to git diff", () => {
    expect(rewriteCommand("git diff")).toBe("git diff --no-color");
  });

  it("adds --quiet to cargo build", () => {
    expect(rewriteCommand("cargo build")).toBe("cargo build --quiet");
  });

  it("adds -q to pytest", () => {
    expect(rewriteCommand("pytest")).toBe("pytest -q");
  });

  it("does not double-add flags", () => {
    expect(rewriteCommand("npm install --silent")).toBe("npm install --silent");
  });

  it("returns unchanged for commands without rewrites", () => {
    expect(rewriteCommand("echo hello")).toBe("echo hello");
  });

  it("returns unchanged for ls", () => {
    expect(rewriteCommand("ls -la")).toBe("ls -la");
  });
});

describe("preprocessOutput", () => {
  it("runs all applicable stages", () => {
    const input =
      "\x1b[31mError\x1b[0m in /Users/alice/myproject/src/main.ts:42\n\n\n\n\x1b[32mOK\x1b[0m in /Users/alice/myproject/src/utils.ts:10";
    const result = preprocessOutput(input);
    expect(result.output).not.toContain("\x1b");
    expect(result.output).not.toContain("/Users/alice/myproject/");
    expect(result.stages.length).toBeGreaterThan(0);
  });

  it("returns unchanged for plain text with no paths", () => {
    const result = preprocessOutput("just some plain text");
    expect(result.output).toBe("just some plain text");
  });
});

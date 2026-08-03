/**
 * Code parser tests — verify symbol, import, and call extraction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseFile, initParser, preloadLanguages } from "../src/index/parser.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `warden-parser-test-${Date.now()}`);

function writeTestFile(name: string, content: string): string {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(async () => {
  await initParser();
  await preloadLanguages([".ts", ".py"]);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("parser — TypeScript", () => {
  it("extracts function declarations", async () => {
    const path = writeTestFile(
      "funcs.ts",
      [
        "export function foo(a: string, b: number): void {",
        "  console.log(a, b);",
        "}",
        "",
        "async function bar(): Promise<string> {",
        "  return 'hello';",
        "}",
      ].join("\n"),
    );
    const result = parseFile(path);
    expect(result.symbols.length).toBe(2);
    const foo = result.symbols.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.kind).toBe("function");
    expect(foo!.exported).toBe(true);
    expect(foo!.params).toEqual(["a", "b"]);
    expect(foo!.startLine).toBe(1);
    const bar = result.symbols.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar!.async).toBe(true);
    expect(bar!.exported).toBe(false);
  });

  it("extracts arrow functions", async () => {
    const path = writeTestFile(
      "arrows.ts",
      [
        "export const greet = (name: string) => {",
        "  return `hello ${name}`;",
        "};",
        "",
        "const asyncFn = async (x: number) => x * 2;",
      ].join("\n"),
    );
    const result = parseFile(path);
    expect(result.symbols.length).toBe(2);
    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.exported).toBe(true);
    expect(greet!.params).toEqual(["name"]);
    const asyncFn = result.symbols.find((s) => s.name === "asyncFn");
    expect(asyncFn).toBeDefined();
    expect(asyncFn!.async).toBe(true);
  });

  it("extracts class declarations with methods", async () => {
    const path = writeTestFile(
      "classes.ts",
      [
        "export class UserService {",
        "  private db: Database;",
        "",
        "  constructor(db: Database) {",
        "    this.db = db;",
        "  }",
        "",
        "  async getUser(id: string): Promise<User> {",
        "    return this.db.find(id);",
        "  }",
        "",
        "  static create(db: Database): UserService {",
        "    return new UserService(db);",
        "  }",
        "}",
      ].join("\n"),
    );
    const result = parseFile(path);
    const cls = result.symbols.find(
      (s) => s.name === "UserService" && s.kind === "class",
    );
    expect(cls).toBeDefined();
    expect(cls!.exported).toBe(true);

    const methods = result.symbols.filter((s) => s.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const getUser = methods.find((m) => m.name === "getUser");
    expect(getUser).toBeDefined();
    expect(getUser!.className).toBe("UserService");
    expect(getUser!.async).toBe(true);
  });

  it("extracts interface and type declarations", async () => {
    const path = writeTestFile(
      "types.ts",
      [
        "export interface User {",
        "  id: string;",
        "  name: string;",
        "}",
        "",
        "type Status = 'active' | 'inactive';",
        "",
        "export enum Role {",
        "  Admin,",
        "  User,",
        "}",
      ].join("\n"),
    );
    const result = parseFile(path);
    const iface = result.symbols.find(
      (s) => s.name === "User" && s.kind === "interface",
    );
    expect(iface).toBeDefined();
    expect(iface!.exported).toBe(true);
    const status = result.symbols.find(
      (s) => s.name === "Status" && s.kind === "type",
    );
    expect(status).toBeDefined();
    const role = result.symbols.find(
      (s) => s.name === "Role" && s.kind === "enum",
    );
    expect(role).toBeDefined();
    expect(role!.exported).toBe(true);
  });

  it("extracts imports", async () => {
    const path = writeTestFile(
      "imports.ts",
      [
        'import { foo, bar as baz } from "./utils";',
        'import React from "react";',
        'import * as path from "node:path";',
        'import type { User } from "./types";',
      ].join("\n"),
    );
    const result = parseFile(path);
    expect(result.imports.length).toBe(4);
    const utilsImp = result.imports.find((i) => i.from === "./utils");
    expect(utilsImp).toBeDefined();
    expect(utilsImp!.names).toContain("foo");
    expect(utilsImp!.names).toContain("bar");
    const reactImp = result.imports.find((i) => i.from === "react");
    expect(reactImp).toBeDefined();
    expect(reactImp!.names).toContain("React");
  });

  it("extracts call sites", async () => {
    const path = writeTestFile(
      "calls.ts",
      [
        "function outer() {",
        "  inner();",
        "  helper.process();",
        "  if (check()) {",
        "    validate();",
        "  }",
        "}",
      ].join("\n"),
    );
    const result = parseFile(path);
    const calls = result.calls.filter((c) => c.callerName === "outer");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.calleeName === "inner")).toBe(true);
    expect(calls.some((c) => c.calleeName === "validate")).toBe(true);
    // "check" should also be captured
    expect(calls.some((c) => c.calleeName === "check")).toBe(true);
  });

  it("skips keywords as call names", async () => {
    const path = writeTestFile(
      "keywords.ts",
      [
        "function test() {",
        "  if (true) { return; }",
        "  for (let i = 0; i < 10; i++) {",
        "    process(i);",
        "  }",
        "}",
      ].join("\n"),
    );
    const result = parseFile(path);
    const calls = result.calls.filter((c) => c.callerName === "test");
    // "if", "for", "return" should NOT be in calls
    expect(calls.some((c) => c.calleeName === "if")).toBe(false);
    expect(calls.some((c) => c.calleeName === "for")).toBe(false);
    expect(calls.some((c) => c.calleeName === "return")).toBe(false);
    // "process" should be
    expect(calls.some((c) => c.calleeName === "process")).toBe(true);
  });
});

describe("parser — Python", () => {
  it("extracts function and class definitions", async () => {
    const path = writeTestFile(
      "module.py",
      [
        "def greet(name):",
        "    print(f'hello {name}')",
        "    return name",
        "",
        "async def fetch(url):",
        "    response = await get(url)",
        "    return response",
        "",
        "class UserStore:",
        "    def __init__(self, db):",
        "        self.db = db",
        "",
        "    def get_user(self, id):",
        "        return self.db.find(id)",
        "",
        "    async def create(self, data):",
        "        return await self.db.insert(data)",
      ].join("\n"),
    );
    const result = parseFile(path);
    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe("function");
    expect(greet!.params).toEqual(["name"]);

    const fetchSym = result.symbols.find((s) => s.name === "fetch");
    expect(fetchSym).toBeDefined();
    expect(fetchSym!.async).toBe(true);

    const cls = result.symbols.find(
      (s) => s.name === "UserStore" && s.kind === "class",
    );
    expect(cls).toBeDefined();

    const methods = result.symbols.filter((s) => s.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const getUser = methods.find((m) => m.name === "get_user");
    expect(getUser).toBeDefined();
    expect(getUser!.className).toBe("UserStore");
  });

  it("extracts Python imports", async () => {
    const path = writeTestFile(
      "imports.py",
      [
        "import os",
        "from typing import List, Dict",
        "from .utils import helper",
      ].join("\n"),
    );
    const result = parseFile(path);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    const typingImp = result.imports.find((i) => i.from === "typing");
    expect(typingImp).toBeDefined();
    expect(typingImp!.names).toContain("List");
    expect(typingImp!.names).toContain("Dict");
  });
});

describe("parser — edge cases", () => {
  it("handles empty files", async () => {
    const path = writeTestFile("empty.ts", "");
    const result = parseFile(path);
    expect(result.symbols.length).toBe(0);
    expect(result.imports.length).toBe(0);
    expect(result.calls.length).toBe(0);
  });

  it("handles files with only comments", async () => {
    const path = writeTestFile(
      "comments.ts",
      ["// This is a comment", "/* multi", "   line */", "/** JSDoc */"].join(
        "\n",
      ),
    );
    const result = parseFile(path);
    expect(result.symbols.length).toBe(0);
  });

  it("handles unsupported file extensions gracefully", async () => {
    const path = writeTestFile("readme.md", "# Hello\n\nSome text.");
    const result = parseFile(path);
    expect(result.symbols.length).toBe(0);
  });
});

/**
 * Indexer and graph query tests — end-to-end indexing + structural queries.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Warden } from "../src/warden.js";
import { CodeIndex } from "../src/index/indexer.js";
import { GraphQuery } from "../src/index/graph.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

/** Platform-agnostic relative path for test assertions. */
const rel = (p: string) => p.split("/").join(sep);

const TEST_DIR = join(tmpdir(), `warden-index-test-${Date.now()}`);
const TEST_DB = join(TEST_DIR, "test.warden.db");

let warden: Warden;
let indexer: CodeIndex;
let graph: GraphQuery;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Create a small project to index
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });

  // auth.ts — has functions that are called by others
  writeFileSync(
    join(TEST_DIR, "src", "auth.ts"),
    [
      "export function validate(token: string): boolean {",
      "  return checkToken(token);",
      "}",
      "",
      "function checkToken(token: string): boolean {",
      "  return token.length > 0;",
      "}",
      "",
      "export function login(user: string, pass: string): string {",
      "  const token = generateToken(user);",
      "  if (validate(token)) {",
      "    return token;",
      "  }",
      "  return '';",
      "}",
      "",
      "function generateToken(user: string): string {",
      "  return user + '-token';",
      "}",
    ].join("\n"),
  );

  // user.ts — imports from auth.ts
  writeFileSync(
    join(TEST_DIR, "src", "user.ts"),
    [
      'import { validate, login } from "./auth";',
      "",
      "export class UserService {",
      "  private name: string;",
      "",
      "  constructor(name: string) {",
      "    this.name = name;",
      "  }",
      "",
      "  authenticate(pass: string): string | null {",
      "    const token = login(this.name, pass);",
      "    if (token) {",
      "      return token;",
      "    }",
      "    return null;",
      "  }",
      "",
      "  isValid(token: string): boolean {",
      "    return validate(token);",
      "  }",
      "}",
    ].join("\n"),
  );

  // main.ts — entry point
  writeFileSync(
    join(TEST_DIR, "src", "main.ts"),
    [
      'import { UserService } from "./user";',
      "",
      "export function main(): void {",
      "  const service = new UserService('alice');",
      "  const token = service.authenticate('secret');",
      "  if (token) {",
      "    console.log('logged in');",
      "  }",
      "}",
    ].join("\n"),
  );

  // unused.ts — dead code (nobody calls this)
  writeFileSync(
    join(TEST_DIR, "src", "unused.ts"),
    [
      "export function deadFunction(): void {",
      "  console.log('nobody calls me');",
      "}",
      "",
      "function alsoDead(): number {",
      "  return 42;",
      "}",
    ].join("\n"),
  );

  warden = await Warden.create({ dbPath: TEST_DB, repoRoot: TEST_DIR });
  indexer = new CodeIndex(warden.store);
  graph = new GraphQuery(warden.store, TEST_DIR);

  // Index the project
  await indexer.index({ repoRoot: TEST_DIR });
});

afterAll(() => {
  warden.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("CodeIndex", () => {
  it("indexes all source files", () => {
    const stats = indexer.indexStats(TEST_DIR);
    expect(stats.files).toBe(4);
    expect(stats.symbols).toBeGreaterThan(5);
    expect(stats.calls).toBeGreaterThan(3);
  });

  it("is incremental — second index with no changes parses 0 files", async () => {
    const result = await indexer.index({ repoRoot: TEST_DIR });
    expect(result.filesParsed).toBe(0);
  });

  it("re-indexes changed files", async () => {
    // Touch a file
    const authPath = join(TEST_DIR, "src", "auth.ts");
    const content = require("node:fs").readFileSync(authPath, "utf8");
    require("node:fs").writeFileSync(authPath, content + "\n// touched\n");
    const result = await indexer.index({ repoRoot: TEST_DIR });
    expect(result.filesParsed).toBe(1);
  });
});

describe("GraphQuery — callers", () => {
  it("finds callers of validate()", () => {
    const callers = graph.callers("validate");
    // validate is called by login() in auth.ts and isValid() in user.ts
    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(callers.some((c) => c.callerName === "login")).toBe(true);
    expect(callers.some((c) => c.callerName === "UserService.isValid")).toBe(
      true,
    );
  });

  it("finds callers of login()", () => {
    const callers = graph.callers("login");
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(
      callers.some((c) => c.callerName === "UserService.authenticate"),
    ).toBe(true);
  });

  it("returns empty for unknown functions", () => {
    const callers = graph.callers("nonexistent");
    expect(callers.length).toBe(0);
  });
});

describe("GraphQuery — callees", () => {
  it("finds callees of login()", () => {
    const callees = graph.callees("login");
    // login calls generateToken and validate
    expect(callees.length).toBeGreaterThanOrEqual(2);
    expect(callees.some((c) => c.calleeName === "generateToken")).toBe(true);
    expect(callees.some((c) => c.calleeName === "validate")).toBe(true);
  });

  it("finds callees of main()", () => {
    const callees = graph.callees("main");
    expect(callees.length).toBeGreaterThanOrEqual(1);
    expect(callees.some((c) => c.calleeName === "UserService")).toBe(true);
  });
});

describe("GraphQuery — impact", () => {
  it("finds dependents of auth.ts", () => {
    const result = graph.impact(join(TEST_DIR, "src", "auth.ts"));
    expect(result.directDependents).toContain(rel("src/user.ts"));
    expect(result.affectedSymbols.length).toBeGreaterThan(0);
    expect(result.affectedSymbols.some((s) => s.name === "validate")).toBe(
      true,
    );
    expect(result.affectedSymbols.some((s) => s.name === "login")).toBe(true);
  });

  it("finds transitive dependents", () => {
    const result = graph.impact(join(TEST_DIR, "src", "auth.ts"));
    // user.ts is a direct dependent, main.ts imports user.ts
    expect(result.transitiveDependents).toContain(rel("src/main.ts"));
  });

  it("assigns risk level", () => {
    const result = graph.impact(join(TEST_DIR, "src", "auth.ts"));
    expect(["low", "medium", "high"]).toContain(result.risk);
  });
});

describe("GraphQuery — architecture", () => {
  it("returns project overview", () => {
    const arch = graph.architecture();
    expect(arch.totalFiles).toBe(4);
    expect(arch.totalSymbols).toBeGreaterThan(5);
    expect(arch.languages.length).toBeGreaterThan(0);
    expect(arch.languages.some((l) => l.language === "TypeScript")).toBe(true);
    expect(arch.packages.length).toBeGreaterThan(0);
    expect(arch.entryPoints.length).toBeGreaterThan(0);
    expect(arch.entryPoints.some((e) => e.name === "main")).toBe(true);
  });
});

describe("GraphQuery — search", () => {
  it("finds symbols by name", () => {
    const results = graph.search("validate");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.name === "validate")).toBe(true);
  });

  it("finds symbols by partial name", () => {
    const results = graph.search("token");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(
      results.some(
        (r) => r.name === "checkToken" || r.name === "generateToken",
      ),
    ).toBe(true);
  });
});

describe("GraphQuery — dead code", () => {
  it("finds functions with zero callers", () => {
    const dead = graph.deadCode();
    // deadFunction and alsoDead should be in there
    expect(dead.some((d) => d.name === "deadFunction")).toBe(true);
    expect(dead.some((d) => d.name === "alsoDead")).toBe(true);
  });

  it("does not include functions that are called", () => {
    const dead = graph.deadCode();
    expect(dead.some((d) => d.name === "validate")).toBe(false);
    expect(dead.some((d) => d.name === "login")).toBe(false);
  });
});

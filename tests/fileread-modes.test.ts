/**
 * Tests for AST-aware read modes in the file-read pruning module.
 *
 * Verifies:
 *   1. "full" mode returns raw unchanged
 *   2. "outline" mode returns only structural headers (verbatim)
 *   3. "signatures" mode returns AST symbol declarations (verbatim + annotations)
 *   4. "symbol" mode returns one symbol's body (verbatim line range)
 *   5. "imports" mode returns only import lines (verbatim)
 *   6. "auto" mode (default) preserves existing behavior
 *   7. Guard invariant holds for all modes — every non-annotation line is verbatim
 *   8. AST outline uses verbatim file lines (not synthetic signatures)
 *   9. Fallback to regex when no code index available
 *  10. Edge cases: symbol not found, no imports, no headers, empty file
 */
import { describe, it, expect } from "vitest";
import { fileReadModule } from "../src/pruner/modules/fileread.js";
import { verifyInclusion } from "../src/pruner/guard.js";
import type { TaskContext } from "../src/classifier/types.js";
import type { CodeIndexForPruning, PruneOptions } from "../src/pruner/types.js";

const task: TaskContext = {
  type: "bug-fix",
  relevanceHint: "auth",
  userMessage: "fix auth bug",
  toolName: "file_read",
};

// Sample file with multi-line declarations (to test verbatim vs synthetic)
const SAMPLE_FILE = `import { createConnection } from "mysql";
import type { Pool } from "mysql";
import { Logger } from "./logger";

export interface User {
  id: number;
  name: string;
  email: string;
}

export type AuthToken = string;

export class AuthService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async login(
    user: string,
    pass: string,
  ): Promise<AuthToken> {
    const token = await this.generateToken(user);
    return token;
  }

  async logout(token: AuthToken): Promise<void> {
    await this.pool.execute("DELETE FROM sessions WHERE token = ?", [token]);
  }

  private async generateToken(user: string): Promise<AuthToken> {
    return Math.random().toString(36);
  }
}

export function validateEmail(email: string): boolean {
  return email.includes("@");
}

const helper = (x: number) => x * 2;
`;

// Mock code index that returns symbols matching the sample file
function mockCodeIndex(): CodeIndexForPruning {
  const symbols = [
    { name: "User", kind: "interface", startLine: 5, endLine: 9, params: [], exported: true, isAsync: false, className: null },
    { name: "AuthToken", kind: "type", startLine: 11, endLine: 11, params: [], exported: true, isAsync: false, className: null },
    { name: "AuthService", kind: "class", startLine: 13, endLine: 35, params: ["Pool"], exported: true, isAsync: false, className: null },
    { name: "constructor", kind: "method", startLine: 16, endLine: 18, params: ["Pool"], exported: false, isAsync: false, className: "AuthService" },
    { name: "login", kind: "method", startLine: 20, endLine: 26, params: ["user: string", "pass: string"], exported: false, isAsync: true, className: "AuthService" },
    { name: "logout", kind: "method", startLine: 28, endLine: 30, params: ["token: AuthToken"], exported: false, isAsync: true, className: "AuthService" },
    { name: "generateToken", kind: "method", startLine: 32, endLine: 34, params: ["user: string"], exported: false, isAsync: true, className: "AuthService" },
    { name: "validateEmail", kind: "function", startLine: 37, endLine: 39, params: ["email: string"], exported: true, isAsync: false, className: null },
  ];
  return {
    getSymbolsForFile: () => symbols,
    hasIndex: () => true,
  };
}

const baseOpts: PruneOptions = {
  fileReadLargeThresholdLines: 5, // force pruning on the sample file
};

describe("file-read AST-aware modes", () => {
  describe("full mode", () => {
    it("returns raw content unchanged", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "full",
      });
      expect(result.prunedOutput).toBe(SAMPLE_FILE);
      expect(result.tokensPruned).toBe(result.tokensFull);
      expect(result.removed.tokensRemoved).toBe(0);
    });

    it("guard passes (output is raw)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "full",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });
  });

  describe("imports mode", () => {
    it("returns only import lines (verbatim)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "imports",
      });
      const lines = result.prunedOutput.split("\n");
      // First line is annotation, rest are import lines
      expect(lines.length).toBe(4); // 1 annotation + 3 imports
      expect(lines[1]).toBe('import { createConnection } from "mysql";');
      expect(lines[2]).toBe('import type { Pool } from "mysql";');
      expect(lines[3]).toBe('import { Logger } from "./logger";');
    });

    it("guard passes — all import lines are verbatim", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "imports",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("returns raw when no imports found", () => {
      const noImports = "const x = 1;\nconst y = 2;\n";
      const result = fileReadModule.prune(noImports, task, {
        ...baseOpts,
        readMode: "imports",
      });
      expect(result.prunedOutput).toBe(noImports);
    });
  });

  describe("outline mode", () => {
    it("returns only structural header lines (regex, no AST index)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "outline",
      });
      const lines = result.prunedOutput.split("\n");
      // First line is annotation, rest are header lines from the file
      expect(lines.length).toBeGreaterThan(1);
      // Every non-annotation line should be a verbatim line from the file
      for (let i = 1; i < lines.length; i++) {
        expect(SAMPLE_FILE).toContain(lines[i]);
      }
    });

    it("guard passes (regex outline)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "outline",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("uses AST symbols when code index available (verbatim lines)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "outline",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      const lines = result.prunedOutput.split("\n");
      // First line is annotation
      expect(lines[0]).toContain("outline mode");
      // Should contain verbatim lines from the file at symbol start positions
      // e.g., line 6 = "export interface User {", line 14 = "export class AuthService {"
      const content = lines.slice(1).join("\n");
      expect(content).toContain("export interface User {");
      expect(content).toContain("export class AuthService {");
    });

    it("guard passes (AST outline)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "outline",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("returns raw when no headers found", () => {
      const noHeaders = "console.log('hello');\nconsole.log('world');\n";
      const result = fileReadModule.prune(noHeaders, task, {
        ...baseOpts,
        readMode: "outline",
      });
      expect(result.prunedOutput).toBe(noHeaders);
    });
  });

  describe("signatures mode", () => {
    it("returns AST symbol declarations with annotations (verbatim + formatted)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "signatures",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      const lines = result.prunedOutput.split("\n");
      // Should have: 1 header annotation + (annotation + verbatim) per symbol
      // 8 symbols × 2 lines + 1 header = 17 lines
      expect(lines.length).toBe(17);
      // Check that annotations contain formatted signatures
      const annotations = lines.filter((l) => l.includes("‹warden›"));
      expect(annotations.length).toBe(9); // 1 header + 8 symbol annotations
      // Check that verbatim lines are actual file lines
      const verbatimLines = lines.filter((l) => !l.includes("‹warden›") && l.trim().length > 0);
      for (const vline of verbatimLines) {
        expect(SAMPLE_FILE).toContain(vline);
      }
    });

    it("guard passes (signatures mode)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "signatures",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("falls back to regex headers when no AST index", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "signatures",
      });
      const lines = result.prunedOutput.split("\n");
      expect(lines[0]).toContain("no AST index");
      // All non-annotation lines should be verbatim
      for (const line of lines) {
        if (!line.includes("‹warden›") && line.trim().length > 0) {
          expect(SAMPLE_FILE).toContain(line);
        }
      }
    });

    it("guard passes (signatures regex fallback)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "signatures",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });
  });

  describe("symbol mode", () => {
    it("returns one symbol's body (AST, verbatim line range)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "login",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      const lines = result.prunedOutput.split("\n");
      // First line is annotation, rest is the symbol body
      expect(lines[0]).toContain("symbol mode");
      expect(lines[0]).toContain("login");
      // The body should be lines 21-26 from the file (1-based)
      // Line 21 = "  async login(" — verbatim
      const body = lines.slice(1).join("\n");
      expect(body).toContain("async login(");
      expect(body).toContain("return token;");
    });

    it("guard passes (symbol mode AST)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "login",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("finds class methods by ClassName.method name", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "AuthService.login",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      expect(result.removed.summary).toContain("login");
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("falls back to regex when no AST index", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "validateEmail",
      });
      const lines = result.prunedOutput.split("\n");
      expect(lines[0]).toContain("regex fallback");
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("returns raw when symbol not found (AST)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "nonExistentFunction",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      expect(result.prunedOutput).toBe(SAMPLE_FILE);
    });

    it("returns raw when symbol not found (regex fallback)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
        symbolName: "nonExistentFunction",
      });
      expect(result.prunedOutput).toBe(SAMPLE_FILE);
    });

    it("returns raw when no symbolName provided", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "symbol",
      });
      expect(result.prunedOutput).toBe(SAMPLE_FILE);
    });
  });

  describe("auto mode (default)", () => {
    it("preserves existing behavior for small files (returns raw)", () => {
      const small = "const x = 1;\n";
      const result = fileReadModule.prune(small, task, {
        ...baseOpts,
        fileReadLargeThresholdLines: 400,
      });
      expect(result.prunedOutput).toBe(small);
    });

    it("preserves existing behavior for large files (slice + outline)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "auto",
      });
      // Should prune (file is larger than threshold of 5)
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });

    it("AST outline in auto mode uses verbatim lines (not synthetic signatures)", () => {
      const result = fileReadModule.prune(SAMPLE_FILE, task, {
        ...baseOpts,
        readMode: "auto",
        codeIndex: mockCodeIndex(),
        filePath: "src/auth.ts",
        repoRoot: "/repo",
      });
      // Guard must pass — if synthetic signatures were used, guard would fail
      expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
    });
  });

  describe("guard invariant — all modes", () => {
    const modes: Array<{ mode: string; extra?: Partial<PruneOptions> }> = [
      { mode: "full" },
      { mode: "auto" },
      { mode: "outline" },
      { mode: "imports" },
      { mode: "signatures", extra: { codeIndex: mockCodeIndex(), filePath: "src/auth.ts", repoRoot: "/repo" } },
      { mode: "signatures" },
      { mode: "symbol", extra: { symbolName: "login", codeIndex: mockCodeIndex(), filePath: "src/auth.ts", repoRoot: "/repo" } },
      { mode: "symbol", extra: { symbolName: "validateEmail" } },
      { mode: "outline", extra: { codeIndex: mockCodeIndex(), filePath: "src/auth.ts", repoRoot: "/repo" } },
    ];

    for (const { mode, extra } of modes) {
      it(`guard passes for "${mode}" mode`, () => {
        const result = fileReadModule.prune(SAMPLE_FILE, task, {
          ...baseOpts,
          readMode: mode as PruneOptions["readMode"],
          ...extra,
        });
        expect(verifyInclusion(SAMPLE_FILE, result.prunedOutput)).toBe(true);
      });
    }
  });

  describe("edge cases", () => {
    it("handles empty file", () => {
      const result = fileReadModule.prune("", task, {
        ...baseOpts,
        readMode: "outline",
      });
      expect(result.prunedOutput).toBe("");
    });

    it("handles file with only blank lines", () => {
      const blank = "\n\n\n";
      const result = fileReadModule.prune(blank, task, {
        ...baseOpts,
        readMode: "outline",
      });
      // No headers found, returns raw
      expect(result.prunedOutput).toBe(blank);
    });
  });
});

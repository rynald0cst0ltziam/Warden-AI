/**
 * Compress module tests — validation, protected segments, sentence scoring.
 */
import { describe, it, expect } from "vitest";
import { compressFile, scoreSentence } from "../src/compress/index.js";

describe("compressFile", () => {
  it("preserves code blocks verbatim", () => {
    const input = "Some prose here.\n\n```bash\nnpm test\n```\n\nMore prose.";
    const result = compressFile(input, "full");
    expect(result.compressed).toContain("```bash\nnpm test\n```");
    expect(result.validationOk).toBe(true);
  });

  it("preserves inline code verbatim", () => {
    const input = "Use `warden_grep` to search.";
    const result = compressFile(input, "full");
    expect(result.compressed).toContain("`warden_grep`");
    expect(result.validationOk).toBe(true);
  });

  it("preserves headings verbatim", () => {
    const input =
      "## Layer 4: After completing a task — record outcome\n\nSome text.";
    const result = compressFile(input, "ultra");
    expect(result.compressed).toContain(
      "## Layer 4: After completing a task — record outcome",
    );
    expect(result.validationOk).toBe(true);
  });

  it("preserves URLs verbatim", () => {
    const input = "See https://example.com/docs for details.";
    const result = compressFile(input, "full");
    expect(result.compressed).toContain("https://example.com/docs");
    expect(result.validationOk).toBe(true);
  });

  it("preserves file paths verbatim", () => {
    const input = "The config is in src/config/index.ts file.";
    const result = compressFile(input, "full");
    expect(result.compressed).toContain("src/config/index.ts");
    expect(result.validationOk).toBe(true);
  });

  it("reduces token count", () => {
    const input =
      "It is important to note that in order to build the project, you will need to have Node.js installed on your system.";
    const result = compressFile(input, "full");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.reductionPct).toBeGreaterThan(0);
  });

  it("lite level is less aggressive than full", () => {
    const input =
      "It is important to note that in order to build the project, you will need to have Node.js installed.";
    const lite = compressFile(input, "lite");
    const full = compressFile(input, "full");
    expect(full.reductionPct).toBeGreaterThanOrEqual(lite.reductionPct);
  });

  it("ultra level is most aggressive", () => {
    const input =
      "It is important to note that in order to build the project, you will need to have Node.js installed. The project uses npm as its package manager.";
    const lite = compressFile(input, "lite");
    const ultra = compressFile(input, "ultra");
    expect(ultra.reductionPct).toBeGreaterThanOrEqual(lite.reductionPct);
  });

  it("validation passes on all levels for well-formed markdown", () => {
    const input = `# Title

Some prose paragraph here.

\`\`\`bash
npm test
\`\`\`

More prose with \`inline code\` and a [link](https://example.com).`;
    for (const level of ["lite", "full", "ultra"] as const) {
      const result = compressFile(input, level);
      expect(result.validationOk).toBe(true);
      expect(result.validationErrors).toEqual([]);
    }
  });

  it("handles empty input", () => {
    const result = compressFile("", "full");
    expect(result.validationOk).toBe(true);
    expect(result.reductionPct).toBe(0);
  });

  it("handles input with only code blocks", () => {
    const input = "```bash\nnpm test\n```";
    const result = compressFile(input, "ultra");
    expect(result.compressed).toContain("```bash\nnpm test\n```");
    expect(result.validationOk).toBe(true);
  });

  it("strips filler words", () => {
    const input = "This is basically just a really simple test.";
    const result = compressFile(input, "full");
    expect(result.compressed).not.toContain("basically");
    expect(result.compressed).not.toContain("really");
  });

  it("strips verbose phrases", () => {
    const input = "In order to run the tests, you need Node.js.";
    const result = compressFile(input, "full");
    expect(result.compressed).not.toContain("In order to");
  });
});

describe("scoreSentence", () => {
  it("scores technical sentences higher than filler", () => {
    const techScore = scoreSentence(
      "The authMiddleware validates JWT tokens via verifySignature().",
    );
    const fillerScore = scoreSentence(
      "Great question, let me think about that for a moment.",
    );
    expect(techScore).toBeGreaterThan(fillerScore);
  });

  it("penalizes filler starters", () => {
    const score = scoreSentence("Sure, I can help with that.");
    expect(score).toBeLessThan(0);
  });

  it("rewards identifiers", () => {
    const score = scoreSentence(
      "The camelCase identifier and PascalCase class are used.",
    );
    expect(score).toBeGreaterThan(0);
  });

  it("rewards emphasis words", () => {
    const score = scoreSentence("It is critical to never expose the secret.");
    expect(score).toBeGreaterThan(0);
  });

  it("rewards status words", () => {
    const score = scoreSentence("ERROR: connection failed with TIMEOUT.");
    expect(score).toBeGreaterThan(0);
  });

  it("rewards version numbers", () => {
    const score = scoreSentence("Requires Node.js 18.0.0 or higher.");
    expect(score).toBeGreaterThan(0);
  });

  it("penalizes very short sentences", () => {
    const score = scoreSentence("Ok.");
    expect(score).toBeLessThan(0);
  });

  it("penalizes wordy sentences", () => {
    const score = scoreSentence(
      "This is a very very very very very very very very very very very very very very very very very very very very long sentence with lots of words.",
    );
    expect(score).toBeLessThan(10);
  });
});

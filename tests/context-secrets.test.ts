import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectContext } from "../src/context/index.js";

/**
 * Regression: context selection must NEVER proactively surface secret files
 * (.env, keys, credentials). The agent can still read one explicitly via
 * warden_file_read, but a project scan must not pull secrets into context.
 */
describe("context selection — secret file exclusion", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "warden-ctx-"));
    // A normal source file that SHOULD be selectable.
    writeFileSync(
      join(dir, "auth.ts"),
      "export function authenticate(user: string) {\n  return signToken(user);\n}\n",
    );
    // Secret files that must be excluded.
    writeFileSync(join(dir, ".env"), "STRIPE_SECRET_KEY=sk_live_supersecret\n");
    writeFileSync(
      join(dir, ".env.production"),
      "DATABASE_URL=postgres://user:pass@host/db\n",
    );
    writeFileSync(join(dir, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
    writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=abc\n");
    mkdirSync(join(dir, ".ssh"), { recursive: true });
    writeFileSync(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never recommends or packages secret files", async () => {
    const res = await selectContext({
      task: "review authentication and environment config",
      repoRoot: dir,
      maxFiles: 20,
    });

    const allPaths = [
      ...res.recommendations.map((r) => r.filePath),
      ...res.package.map((f) => f.filePath),
    ].map((p) => p.replace(/\\/g, "/"));

    for (const p of allPaths) {
      expect(p).not.toMatch(/(^|\/)\.env(\.|$)/);
      expect(p).not.toMatch(/\.pem$/);
      expect(p).not.toMatch(/(^|\/)\.npmrc$/);
      expect(p).not.toMatch(/(^|\/)id_rsa$/);
    }
  });

  it("still surfaces normal source files", async () => {
    const res = await selectContext({
      task: "fix authenticate function",
      repoRoot: dir,
      maxFiles: 20,
    });
    const paths = res.recommendations
      .map((r) => r.filePath.replace(/\\/g, "/"))
      .join(" ");
    expect(paths).toMatch(/auth\.ts/);
  });
});

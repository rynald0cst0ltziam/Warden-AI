import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerInMcpJson } from "../src/cli/register.js";

/**
 * Regression: MCP registration must merge safely into existing config and
 * must NEVER clobber a config file it can't parse.
 */
describe("register — safe MCP config merge", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warden-reg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new config with Warden registered", () => {
    const p = join(dir, "mcp.json");
    const r = registerInMcpJson(p, "warden", "Test");
    expect(r.registered).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf8"));
    expect(data.mcpServers.Warden).toBeDefined();
    expect(data.mcpServers.Warden.args).toContain("serve");
  });

  it("merges into an existing config without dropping other servers", () => {
    const p = join(dir, "mcp.json");
    writeFileSync(
      p,
      JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    );
    registerInMcpJson(p, "warden", "Test");
    const data = JSON.parse(readFileSync(p, "utf8"));
    expect(data.mcpServers.github).toBeDefined();
    expect(data.mcpServers.Warden).toBeDefined();
  });

  it("is idempotent — re-running reports already registered", () => {
    const p = join(dir, "mcp.json");
    registerInMcpJson(p, "warden", "Test");
    const second = registerInMcpJson(p, "warden", "Test");
    expect(second.registered).toBe(false);
    expect(second.note).toMatch(/already registered/);
  });

  it("migrates old lowercase 'warden' key to 'Warden'", () => {
    const p = join(dir, "mcp.json");
    writeFileSync(
      p,
      JSON.stringify({ mcpServers: { warden: { command: "warden", args: ["serve"] } } }),
    );
    const r = registerInMcpJson(p, "warden", "Test");
    expect(r.registered).toBe(true);
    expect(r.note).toMatch(/migrated/);
    const data = JSON.parse(readFileSync(p, "utf8"));
    expect(data.mcpServers.Warden).toBeDefined();
    expect(data.mcpServers.warden).toBeUndefined();
  });

  it("never clobbers a malformed (unparseable) config", () => {
    const p = join(dir, "mcp.json");
    const garbage = "{ this is not valid json ]]]";
    writeFileSync(p, garbage);
    const r = registerInMcpJson(p, "warden", "Test");
    expect(r.registered).toBe(false);
    // The original bytes must be untouched.
    expect(readFileSync(p, "utf8")).toBe(garbage);
  });
});

/**
 * E2E runtime tests for Warden proxy — spawns the real CLI binary,
 * talks to it over stdio, and verifies lazy-loading, schema compression,
 * response pruning, and passthrough all work correctly.
 *
 * These tests use vitest and spawn the built dist/cli.js. They require
 * `npm run build` to have been run first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// --- Mock upstream MCP server code ---
const UPSTREAM_CODE = `
const tools = [];
for (let i = 1; i <= 20; i++) {
  tools.push({
    name: "tool_" + i,
    description: "This tool performs operation " + i + " on the filesystem. You can use it to read, write, or modify files. Please note that the file path must be absolute. In order to use this tool effectively, you should provide the full path to the file that you want to process. Due to the fact that the tool reads the entire file, you should be careful with very large files. The tool returns the contents of the file as a string.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Tool " + i,
      type: "object",
      properties: {
        path: {
          type: "string",
          title: "File Path",
          description: "Please provide the absolute file path to the file that you want to read. In order to use this tool effectively, you should provide the full path.",
          default: "/tmp",
          examples: ["/tmp/test.txt", "/home/user/file.json"],
          minLength: 1,
        },
        encoding: {
          type: "string",
          default: "utf8",
          enum: ["utf8", "base64", "hex"],
          description: "The encoding to use when reading the file. You should provide a valid encoding string.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 1000000,
          default: 0,
          description: "The byte offset to start reading from. Please note that this is a zero-based offset.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim().length === 0) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-upstream", version: "1.0.0" },
          },
        }) + "\\n");
      } else if (msg.method === "tools/list") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { tools },
        }) + "\\n");
      } else if (msg.method === "tools/call") {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        if (name === "tool_1") {
          // Return a large response for pruning tests
          const lines = [];
          for (let j = 0; j < 200; j++) {
            lines.push("Line " + j + ": " + (j % 10 === 0 ? "ERROR: something failed" : "info: routine output line " + j));
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: {
              content: [{ type: "text", text: lines.join("\\n") }],
              isError: false,
            },
          }) + "\\n");
        } else if (name === "tool_2") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: {
              content: [{ type: "text", text: "Tool 2 executed successfully. Result: OK" }],
              isError: false,
            },
          }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: {
              content: [{ type: "text", text: "Tool " + name + " called with " + JSON.stringify(args) }],
              isError: false,
            },
          }) + "\\n");
        }
      } else if (msg.method === "ping") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      } else {
        // Unknown method — pass through
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32601, message: "Method not found: " + msg.method },
        }) + "\\n");
      }
    } catch (e) {
      process.stderr.write("upstream parse error: " + e.message + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface ProxyHandle {
  proc: ChildProcess;
  tmpDir: string;
  send: (msg: Record<string, unknown>) => void;
  collect: (timeoutMs?: number, expectedCount?: number) => Promise<Record<string, unknown>[]>;
  close: () => void;
}

function startProxy(extraArgs: string[]): ProxyHandle {
  const tmpDir = join(tmpdir(), `warden-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
  const upstreamPath = join(tmpDir, "upstream.cjs");
  writeFileSync(upstreamPath, UPSTREAM_CODE);

  const proc = spawn(process.execPath, [CLI_PATH, "proxy", "node", upstreamPath, ...extraArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: join(__dirname, ".."),
  });

  const responses: Record<string, unknown>[] = [];
  let buf = "";
  let resolveCollect: ((value: Record<string, unknown>[]) => void) | null = null;
  let collectTimeout: NodeJS.Timeout | null = null;
  let expectedCount = 1;

  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      try {
        const msg = JSON.parse(line);
        responses.push(msg);
        if (resolveCollect && responses.length >= expectedCount) {
          const r = resolveCollect;
          resolveCollect = null;
          if (collectTimeout) clearTimeout(collectTimeout);
          r(responses.splice(0));
        }
      } catch {
        // ignore non-JSON
      }
    }
  });

  proc.stderr!.on("data", () => {
    // Suppress stderr in tests
  });

  const send = (msg: Record<string, unknown>): void => {
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  };

  const collect = (timeoutMs = 5000, count = 1): Promise<Record<string, unknown>[]> => {
    expectedCount = count;
    return new Promise((resolve) => {
      if (responses.length >= expectedCount) {
        resolve(responses.splice(0));
        return;
      }
      resolveCollect = resolve;
      collectTimeout = setTimeout(() => {
        resolveCollect = null;
        resolve(responses.splice(0));
      }, timeoutMs);
    });
  };

  const close = (): void => {
    try { proc.kill(); } catch { /* already dead */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { proc, tmpDir, send, collect, close };
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function findResponseById(responses: Record<string, unknown>[], id: string | number): Record<string, unknown> | undefined {
  return responses.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy e2e — default mode (lazy + schema compression ON)", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error("dist/cli.js not found. Run `npm run build` first.");
    }
    proxy = startProxy([]);
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    if (proxy) proxy.close();
  });

  // Shared timeout for all tests in this block — process spawning is slow
  // under full-suite load.
  const T = 15000;

  it("initializes upstream MCP server", async () => {
    proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const responses = await proxy.collect(T);
    const init = findResponseById(responses, 1);
    expect(init).toBeDefined();
    expect(init!.result).toBeDefined();
    const result = init!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo).toBeDefined();
  }, T);

  it("tools/list returns 3 meta-tools (lazy mode ON by default)", async () => {
    proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const responses = await proxy.collect(T);
    const listResp = findResponseById(responses, 2);
    expect(listResp).toBeDefined();
    const result = listResp!.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("warden_list_tools");
    expect(names).toContain("warden_get_tool_schema");
    expect(names).toContain("warden_invoke_tool");
  }, T);

  it("meta-tools have valid inputSchemas", async () => {
    proxy.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const responses = await proxy.collect(T);
    const listResp = findResponseById(responses, 3);
    expect(listResp).toBeDefined();
    const tools = (listResp!.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools;
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  }, T);

  it("warden_list_tools returns compact listing of all 20 tools", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "warden_list_tools", arguments: {} },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 10);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    const text = result.content[0]!.text;
    for (let i = 1; i <= 20; i++) {
      expect(text).toContain("tool_" + i);
    }
  }, T);

  it("warden_get_tool_schema returns full schema for a specific tool", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "warden_get_tool_schema", arguments: { name: "tool_1" } },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 11);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const text = result.content[0]!.text;
    expect(text).toContain("tool_1");
    expect(text).toContain("path");
    expect(text).toContain("encoding");
    expect(text).toContain("offset");
    expect(text).not.toContain("$schema");
    expect(text).not.toContain('"File Path"');
  }, T);

  it("warden_get_tool_schema preserves validation constraints", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "warden_get_tool_schema", arguments: { name: "tool_1" } },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 12);
    expect(resp).toBeDefined();
    const text = (resp!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('"required"');
    expect(text).toContain('"path"');
    expect(text).toContain('"type"');
    expect(text).toContain('"enum"');
    expect(text).toContain('"minimum"');
    expect(text).toContain('"maximum"');
    expect(text).toContain('"minLength"');
    expect(text).toContain('"additionalProperties"');
  }, T);

  it("warden_get_tool_schema returns error for unknown tool", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 13, method: "tools/call",
      params: { name: "warden_get_tool_schema", arguments: { name: "nonexistent_tool" } },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 13);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  }, T);

  it("warden_get_tool_schema returns error for missing name param", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 14, method: "tools/call",
      params: { name: "warden_get_tool_schema", arguments: {} },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 14);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
  }, T);

  it("warden_invoke_tool forwards to upstream and returns result", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: { name: "tool_2", arguments: { path: "/tmp/test.txt" } },
      },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 20);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("Tool 2 executed successfully");
  }, T);

  it("warden_invoke_tool with large response (pruning off by default — full response)", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: { name: "tool_1", arguments: { path: "/tmp/big.txt" } },
      },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 21);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    expect(text).toContain("Line 0:");
    expect(text).toContain("Line 199:");
    expect(text.split("\n").length).toBe(200);
  }, T);

  it("warden_invoke_tool returns error for missing tool name", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 22, method: "tools/call",
      params: { name: "warden_invoke_tool", arguments: { arguments: {} } },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 22);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
  }, T);

  it("non-meta-tool calls are forwarded to upstream (not intercepted)", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 30, method: "tools/call",
      params: { name: "tool_5", arguments: { path: "/tmp/x" } },
    });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 30);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("tool_5");
  }, T);

  it("ping is forwarded to upstream unchanged", async () => {
    proxy.send({ jsonrpc: "2.0", id: 40, method: "ping" });
    const responses = await proxy.collect(T);
    const resp = findResponseById(responses, 40);
    expect(resp).toBeDefined();
    expect(resp!.result).toBeDefined();
  }, T);

  it("batch requests work — mixed meta-tool and forwarded", async () => {
    proxy.send([
      { jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "warden_list_tools", arguments: {} } },
      { jsonrpc: "2.0", id: 51, method: "ping" },
    ] as unknown as Record<string, unknown>);
    const responses = await proxy.collect(T, 2);
    const r50 = findResponseById(responses, 50);
    const r51 = findResponseById(responses, 51);
    expect(r50).toBeDefined();
    expect(r51).toBeDefined();
    const r50Result = r50!.result as { content: Array<{ text: string }> };
    expect(r50Result.content[0]!.text).toContain("tool_1");
  }, T);
});

describe("proxy e2e — --no-lazy (lazy OFF, schema compression still ON)", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = startProxy(["--no-lazy"]);
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(() => {
    if (proxy) proxy.close();
  });

  it("tools/list returns full tool catalog (not meta-tools)", async () => {
    proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await proxy.collect(8000);

    proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const responses = await proxy.collect();
    const listResp = findResponseById(responses, 2);
    expect(listResp).toBeDefined();
    const result = listResp!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    // Should be 20 tools, not 3 meta-tools
    expect(result.tools).toHaveLength(20);
    expect(result.tools[0]!.name).toBe("tool_1");
    // No meta-tools
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("warden_list_tools");
  });

  it("schema compression is still ON — cosmetic fields stripped", async () => {
    proxy.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const responses = await proxy.collect(8000);
    const listResp = findResponseById(responses, 3);
    expect(listResp).toBeDefined();
    const tools = (listResp!.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools;
    const schema = tools[0]!.inputSchema;
    // $schema and title should be stripped (cosmetic)
    expect(schema.$schema).toBeUndefined();
    expect(schema.title).toBeUndefined();
    // Validation constraints preserved
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.path.minLength).toBe(1);
    expect(props.encoding.enum).toEqual(["utf8", "base64", "hex"]);
    expect(props.offset.minimum).toBe(0);
    expect(props.offset.maximum).toBe(1000000);
  });

  it("direct tools/call works (no meta-tool interception)", async () => {
    proxy.send({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "tool_2", arguments: { path: "/tmp/test.txt" } },
    });
    const responses = await proxy.collect(8000);
    const resp = findResponseById(responses, 10);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("Tool 2 executed successfully");
  });
});

describe("proxy e2e — --no-lazy --no-compress-schema (both OFF)", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = startProxy(["--no-lazy", "--no-compress-schema"]);
    // Wait for proxy process to start
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(() => {
    if (proxy) proxy.close();
  });

  it("tools/list returns full catalog with uncompressed schemas", async () => {
    proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await proxy.collect(8000);

    proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const responses = await proxy.collect(8000);
    const listResp = findResponseById(responses, 2);
    expect(listResp).toBeDefined();
    const tools = (listResp!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools).toHaveLength(20);
    // Schema should be uncompressed — cosmetic fields present
    const schema = tools[0]!.inputSchema;
    expect(schema.$schema).toBeDefined();
    expect(schema.title).toBeDefined();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.path.title).toBeDefined();
    expect(props.path.default).toBeDefined();
    expect(props.path.examples).toBeDefined();
  });

  it("descriptions are still compressed (description compression is always on)", async () => {
    proxy.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const responses = await proxy.collect(8000);
    const listResp = findResponseById(responses, 3);
    expect(listResp).toBeDefined();
    const tools = (listResp!.result as { tools: Array<{ description: string }> }).tools;
    // Description should be shorter than the original ~370 chars
    expect(tools[0]!.description.length).toBeLessThan(370);
  });
});

describe("proxy e2e — --prune-responses (response pruning ON)", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = startProxy(["--no-lazy", "--prune-responses"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(() => {
    if (proxy) proxy.close();
  });

  it("large tool-call response is pruned (guard-verified, removal-only)", async () => {
    proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await proxy.collect(8000);

    proxy.send({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "tool_1", arguments: { path: "/tmp/big.txt" } },
    });
    const responses = await proxy.collect(10000);
    const resp = findResponseById(responses, 10);
    expect(resp).toBeDefined();
    const result = resp!.result as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    // Pruning should have reduced the output significantly
    // Original is 200 lines. Pruned should be much shorter.
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThan(200);
    // ERROR lines should be preserved (guard ensures verbatim)
    expect(text).toContain("ERROR");
  });
});

describe("proxy e2e -- lazy levels", () => {
  for (const level of ["low", "medium", "high", "max"] as const) {
    it(`--lazy-level ${level} produces valid listing`, async () => {
      const proxy = startProxy(["--lazy-level", level]);
      try {
        // initialize + tools/list
        proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await proxy.collect();

        // tools/list triggers lazy mode — returns meta-tools
        proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await proxy.collect();

        // Now call warden_list_tools to get the compact listing
        proxy.send({
          jsonrpc: "2.0", id: 10, method: "tools/call",
          params: { name: "warden_list_tools", arguments: {} },
        });
        const responses = await proxy.collect();
        const resp = findResponseById(responses, 10);
        expect(resp).toBeDefined();
        const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(false);
        const text = result.content[0]!.text;
        // All levels should contain tool names
        expect(text).toContain("tool_1");
        expect(text).toContain("tool_20");

        // Level-specific checks
        if (level === "max") {
          // Just names, no parentheses
          const lines = text.trim().split("\n");
          expect(lines[0]).toBe("tool_1");
          expect(text).not.toContain("(");
        } else if (level === "high") {
          // name(args) format, no description
          expect(text).toContain("(");
          expect(text).toContain(")");
          expect(text).not.toContain("filesystem");
        } else if (level === "medium") {
          // name(args): first sentence
          expect(text).toContain("(");
        } else if (level === "low") {
          // name(args): full description
          expect(text).toContain("(");
          expect(text.length).toBeGreaterThan(100);
        }
      } finally {
        proxy.close();
      }
    });
  }
});

describe("proxy e2e -- token reduction measurements", () => {
  it("lazy mode achieves >90% catalog token reduction", async () => {
    // First get baseline (no lazy, no schema compression)
    const baselineProxy = startProxy(["--no-lazy", "--no-compress-schema"]);
    await new Promise((r) => setTimeout(r, 500));
    baselineProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await baselineProxy.collect(8000);
    baselineProxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const baselineResp = await baselineProxy.collect(8000);
    const baselineList = findResponseById(baselineResp, 2);
    expect(baselineList).toBeDefined();
    const baselineTokens = approxTokens(JSON.stringify(baselineList));
    baselineProxy.close();

    // Now get lazy mode
    const lazyProxy = startProxy([]);
    await new Promise((r) => setTimeout(r, 500));
    lazyProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await lazyProxy.collect(8000);
    lazyProxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const lazyResp = await lazyProxy.collect(8000);
    const lazyList = findResponseById(lazyResp, 2);
    expect(lazyList).toBeDefined();
    const lazyTokens = approxTokens(JSON.stringify(lazyList));
    lazyProxy.close();

    // Lazy should be >90% smaller
    const reduction = ((baselineTokens - lazyTokens) / baselineTokens) * 100;
    expect(reduction).toBeGreaterThan(90);
  }, 30000);

  it("schema compression achieves >10% additional reduction (no-lazy)", async () => {
    // Baseline: no lazy, no schema compression
    const baselineProxy = startProxy(["--no-lazy", "--no-compress-schema"]);
    await new Promise((r) => setTimeout(r, 500));
    baselineProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await baselineProxy.collect(8000);
    baselineProxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const baselineResp = await baselineProxy.collect(8000);
    const baselineList = findResponseById(baselineResp, 2);
    expect(baselineList).toBeDefined();
    const baselineTokens = approxTokens(JSON.stringify(baselineList));
    baselineProxy.close();

    // With schema compression (no lazy)
    const compressedProxy = startProxy(["--no-lazy"]);
    await new Promise((r) => setTimeout(r, 500));
    compressedProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await compressedProxy.collect(8000);
    compressedProxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const compressedResp = await compressedProxy.collect(8000);
    const compressedList = findResponseById(compressedResp, 2);
    expect(compressedList).toBeDefined();
    const compressedTokens = approxTokens(JSON.stringify(compressedList));
    compressedProxy.close();

    const reduction = ((baselineTokens - compressedTokens) / baselineTokens) * 100;
    expect(reduction).toBeGreaterThan(10);
  }, 30000);
});

describe("proxy e2e -- guard invariants", () => {
  it("schema compression never removes validation constraints", async () => {
    const proxy = startProxy([]); // both ON
    try {
      await new Promise((r) => setTimeout(r, 500));
      proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await proxy.collect(8000);
      proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await proxy.collect(8000);

      // Get schema for tool_1
      proxy.send({
        jsonrpc: "2.0", id: 10, method: "tools/call",
        params: { name: "warden_get_tool_schema", arguments: { name: "tool_1" } },
      });
      const responses = await proxy.collect(8000);
      const resp = findResponseById(responses, 10);
      expect(resp).toBeDefined();
      const text = (resp!.result as { content: Array<{ text: string }> }).content[0]!.text;
      const schema = JSON.parse(text.split("\n").slice(1).join("\n")); // skip first line (tool name)

      // Every validation constraint must be present
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["path"]);
      expect(schema.additionalProperties).toBe(false);

      const props = schema.properties;
      expect(props.path.type).toBe("string");
      expect(props.path.minLength).toBe(1);
      expect(props.encoding.type).toBe("string");
      expect(props.encoding.enum).toEqual(["utf8", "base64", "hex"]);
      expect(props.offset.type).toBe("integer");
      expect(props.offset.minimum).toBe(0);
      expect(props.offset.maximum).toBe(1000000);
    } finally {
      proxy.close();
    }
  }, 30000);

  it("response pruning keeps every line verbatim from raw", async () => {
    // Get raw response (no pruning)
    const rawProxy = startProxy(["--no-lazy", "--no-compress-schema"]);
    await new Promise((r) => setTimeout(r, 500));
    rawProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await rawProxy.collect(8000);
    rawProxy.send({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "tool_1", arguments: { path: "/tmp/big" } },
    });
    const rawResp = await rawProxy.collect(10000);
    const rawRespObj = findResponseById(rawResp, 10);
    expect(rawRespObj).toBeDefined();
    const rawText = (rawRespObj!.result as { content: Array<{ text: string }> }).content[0]!.text;
    const rawLines = rawText.split("\n");
    rawProxy.close();

    // Get pruned response
    const prunedProxy = startProxy(["--no-lazy", "--prune-responses"]);
    await new Promise((r) => setTimeout(r, 500));
    prunedProxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await prunedProxy.collect(8000);
    prunedProxy.send({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "tool_1", arguments: { path: "/tmp/big" } },
    });
    const prunedResp = await prunedProxy.collect(10000);
    const prunedRespObj = findResponseById(prunedResp, 10);
    expect(prunedRespObj).toBeDefined();
    const prunedText = (prunedRespObj!.result as { content: Array<{ text: string }> }).content[0]!.text;
    const prunedLines = prunedText.split("\n");
    prunedProxy.close();

    // Every pruned CONTENT line must appear verbatim in the raw.
    // Annotation lines (‹warden› …) are metadata added by the pruner,
    // not content from the raw output — skip them.
    for (const line of prunedLines) {
      if (line.startsWith("‹warden›") || line.startsWith("<warden>")) continue;
      expect(rawLines).toContain(line);
    }
    // Pruned should be shorter or equal
    expect(prunedLines.length).toBeLessThanOrEqual(rawLines.length);
  }, 30000);
});

describe("proxy e2e -- env var disable", () => {
  it("WARDEN_PROXY_LAZY=0 disables lazy mode", async () => {
    const tmpDir = join(tmpdir(), `warden-env-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const upstreamPath = join(tmpDir, "upstream.cjs");
    writeFileSync(upstreamPath, UPSTREAM_CODE);

    const proc = spawn(process.execPath, [CLI_PATH, "proxy", "node", upstreamPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, ".."),
      env: { ...process.env, WARDEN_PROXY_LAZY: "0" },
    });

    const responses: Record<string, unknown>[] = [];
    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });

    const collect = (): Promise<Record<string, unknown>[]> =>
      new Promise((resolve) => setTimeout(() => resolve(responses.splice(0)), 2000));

    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await collect();
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const resp = await collect();

    const listResp = findResponseById(resp, 2);
    const tools = (listResp!.result as { tools: Array<{ name: string }> }).tools;
    // Should be 20 tools, not 3 meta-tools
    expect(tools).toHaveLength(20);

    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("WARDEN_PROXY_COMPRESS_SCHEMA=0 disables schema compression", async () => {
    const tmpDir = join(tmpdir(), `warden-env2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const upstreamPath = join(tmpDir, "upstream.cjs");
    writeFileSync(upstreamPath, UPSTREAM_CODE);

    const proc = spawn(process.execPath, [CLI_PATH, "proxy", "node", upstreamPath, "--no-lazy"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, ".."),
      env: { ...process.env, WARDEN_PROXY_COMPRESS_SCHEMA: "0" },
    });

    const responses: Record<string, unknown>[] = [];
    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });

    const collect = (): Promise<Record<string, unknown>[]> =>
      new Promise((resolve) => setTimeout(() => resolve(responses.splice(0)), 2000));

    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await collect();
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const resp = await collect();

    const listResp = findResponseById(resp, 2);
    const tools = (listResp!.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools;
    // Schema should be uncompressed — $schema present
    expect(tools[0]!.inputSchema.$schema).toBeDefined();
    expect(tools[0]!.inputSchema.title).toBeDefined();

    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

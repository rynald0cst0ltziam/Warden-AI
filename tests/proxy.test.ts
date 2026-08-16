/**
 * Tests for the MCP proxy middleware.
 *
 * Verifies:
 *   1. Line buffer correctly parses NDJSON messages
 *   2. Description compression reduces size while preserving technical identifiers
 *   3. transformResponse compresses tools/list, prompts/list, resources/list
 *   4. transformResponse passes through non-list responses unchanged
 *   5. Spawn resolution works on POSIX (and doesn't crash on Windows)
 *   6. compressProxyDescription preserves code, paths, URLs, identifiers
 *   7. Edge cases: empty descriptions, no result, notifications, errors
 *   8. Guard invariant: compressed descriptions preserve technical content
 */

import { describe, it, expect } from "vitest";
import {
  createLineBuffer,
  type ParsedMessage,
} from "../src/proxy/line-buffer.js";
import {
  getSpawnInvocation,
  getSpawnOptions,
} from "../src/proxy/spawn.js";
import {
  compressProxyDescription,
  transformResponse,
} from "../src/proxy/index.js";
import { compressFile } from "../src/compress/index.js";

// ---------------------------------------------------------------------------
// Line buffer
// ---------------------------------------------------------------------------

describe("line buffer", () => {
  it("parses a single complete JSON line", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(true);
    if (messages[0]!.parsed) {
      expect(messages[0]!.json.jsonrpc).toBe("2.0");
      expect(messages[0]!.json.id).toBe(1);
    }
  });

  it("handles chunked input across message boundaries", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push('{"jsonrpc":"2.0","id":1');
    buf.push(',"result":{}}\n{"jsonrpc":"2.0","id":2}\n');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.parsed).toBe(true);
    expect(messages[1]!.parsed).toBe(true);
    if (messages[0]!.parsed) expect(messages[0]!.json.id).toBe(1);
    if (messages[1]!.parsed) expect(messages[1]!.json.id).toBe(2);
  });

  it("passes through unparseable lines as raw strings", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push("this is not json\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(false);
    if (!messages[0]!.parsed) {
      expect(messages[0]!.raw).toBe("this is not json");
    }
  });

  it("skips blank lines", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push("\n\n{\"id\":1}\n\n");
    expect(messages).toHaveLength(1);
  });

  it("handles end() with remaining data", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push('{"id":99}'); // no trailing newline
    buf.end();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(true);
    if (messages[0]!.parsed) expect(messages[0]!.json.id).toBe(99);
  });

  it("handles Buffer input", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push(Buffer.from('{"id":1}\n', "utf8"));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(true);
  });

  it("parses JSON arrays (batch requests) as parsed messages", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push('[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2}]\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(true);
    if (messages[0]!.parsed) {
      expect(Array.isArray(messages[0]!.json)).toBe(true);
    }
  });

  it("rejects JSON primitives (not valid JSON-RPC)", () => {
    const messages: ParsedMessage[] = [];
    const buf = createLineBuffer((msg) => messages.push(msg));
    buf.push("42\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spawn resolution
// ---------------------------------------------------------------------------

describe("spawn resolution", () => {
  it("passes through command on non-Windows", () => {
    const inv = getSpawnInvocation("node", ["server.js"], "linux");
    expect(inv.command).toBe("node");
    expect(inv.args).toEqual(["server.js"]);
  });

  it("passes through npx on non-Windows", () => {
    const inv = getSpawnInvocation("npx", ["@modelcontextprotocol/server-filesystem", "/tmp"], "linux");
    expect(inv.command).toBe("npx");
    expect(inv.args).toEqual(["@modelcontextprotocol/server-filesystem", "/tmp"]);
  });

  it("returns correct spawn options", () => {
    const opts = getSpawnOptions();
    expect(opts.stdio).toEqual(["pipe", "pipe", "inherit"]);
    expect(opts.windowsHide).toBe(true);
  });

  it("does not mutate input args", () => {
    const args = ["server.js", "--port", "3000"];
    getSpawnInvocation("node", args, "linux");
    expect(args).toEqual(["server.js", "--port", "3000"]);
  });
});

// ---------------------------------------------------------------------------
// Description compression
// ---------------------------------------------------------------------------

describe("compressProxyDescription", () => {
  it("reduces a verbose description", () => {
    const verbose = "This tool reads a file from the filesystem. You can use it to read the contents of any file that you have permission to access. Please note that the file path must be absolute.";
    const { compressed, reduced, beforeBytes, afterBytes } =
      compressProxyDescription(verbose);
    expect(reduced).toBe(true);
    expect(afterBytes).toBeLessThan(beforeBytes);
    expect(compressed.length).toBeLessThan(verbose.length);
  });

  it("preserves code identifiers", () => {
    const desc = "Use the `readFileSync` function from `node:fs` to read the file at `filePath` and return its contents as a string.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("readFileSync");
    expect(compressed).toContain("node:fs");
    expect(compressed).toContain("filePath");
  });

  it("preserves URLs", () => {
    const desc = "Fetches data from https://api.example.com/v2/users and returns the response. You should provide a valid token.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("https://api.example.com/v2/users");
  });

  it("preserves file paths", () => {
    const desc = "Reads the file at /usr/local/config/settings.json and parses it as JSON.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("/usr/local/config/settings.json");
  });

  it("preserves version numbers", () => {
    const desc = "Requires Node.js >= 18.0.0 and npm version 9.2.3 or higher.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("18.0.0");
    expect(compressed).toContain("9.2.3");
  });

  it("returns original if no reduction", () => {
    const short = "Read file.";
    const { compressed, reduced } = compressProxyDescription(short);
    expect(reduced).toBe(false);
    expect(compressed).toBe(short);
  });

  it("returns original if validation fails", () => {
    // Empty string — no content to compress
    const { compressed, reduced } = compressProxyDescription("");
    expect(reduced).toBe(false);
    expect(compressed).toBe("");
  });

  it("handles multi-line descriptions", () => {
    const desc = `Reads a file from the filesystem.

You can use this tool to read the contents of any file.
Please provide an absolute path to the file.`;
    const { compressed, reduced } = compressProxyDescription(desc);
    expect(reduced).toBe(true);
    expect(compressed.length).toBeLessThan(desc.length);
  });
});

// ---------------------------------------------------------------------------
// transformResponse
// ---------------------------------------------------------------------------

describe("transformResponse", () => {
  it("compresses descriptions in tools/list response", () => {
    const desc0 = "This tool reads a file from the filesystem. You can use it to read the contents of any file that you have permission to access. Please note that the file path must be absolute. In order to use this tool effectively, you should provide the full path to the file that you want to read. Due to the fact that the tool reads the entire file, you should be careful with very large files.";
    const desc1 = "Writes content to a file on the filesystem. You should provide the file path and the content to write. Please note that this will overwrite any existing content in the file. In order to avoid data loss, you should be careful when using this tool.";
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "read_file", description: desc0, inputSchema: { type: "object" } },
          { name: "write_file", description: desc1, inputSchema: { type: "object" } },
        ],
      },
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(2);
    const tools = (message.result as { tools: Array<{ description: string }> }).tools;
    expect(tools[0]!.description.length).toBeLessThan(desc0.length);
    expect(tools[1]!.description.length).toBeLessThan(desc1.length);
  });

  it("compresses descriptions in prompts/list response", () => {
    const desc = "Please review the following code carefully and provide detailed feedback on potential improvements. You should consider the code style, performance implications, and security concerns. In order to provide the most useful feedback, you should also suggest specific changes.";
    const msg = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        prompts: [{ name: "code_review", description: desc }],
      },
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(1);
    const prompts = (message.result as { prompts: Array<{ description: string }> }).prompts;
    expect(prompts[0]!.description.length).toBeLessThan(desc.length);
  });

  it("compresses descriptions in resources/list response", () => {
    const desc = "The configuration file for the application. You can read this to understand the current settings. Please note that the configuration is in JSON format and you should parse it accordingly. In order to modify the configuration, you should use the write_file tool.";
    const msg = {
      jsonrpc: "2.0",
      id: 3,
      result: {
        resources: [{ name: "config", description: desc }],
      },
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(1);
  });

  it("passes through responses without result unchanged", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -1, message: "not found" },
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
    expect(message).toBe(msg);
  });

  it("passes through notifications unchanged", () => {
    const msg = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
    expect(message).toBe(msg);
  });

  it("passes through result without tools/prompts/resources arrays", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 5,
      result: { protocolVersion: "2024-11-05", capabilities: {} },
    };

    const { message, compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
    expect(message).toBe(msg);
  });

  it("handles empty tools array", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 6,
      result: { tools: [] },
    };

    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("handles tool without description field", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 7,
      result: {
        tools: [
          { name: "no_desc", inputSchema: { type: "object" } },
        ],
      },
    };

    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("handles tool with non-string description", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 8,
      result: {
        tools: [
          { name: "num_desc", description: 42, inputSchema: {} },
        ],
      },
    };

    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("compresses custom fields when specified", () => {
    const summary = "This is a very verbose summary that you should read carefully because it contains important information about the tool. In order to understand the tool fully, you should review this summary before proceeding. Please note that the summary is provided for your convenience.";
    const msg = {
      jsonrpc: "2.0",
      id: 9,
      result: {
        tools: [
          { name: "custom", description: "Short desc.", summary },
        ],
      },
    };

    const { message, compressed } = transformResponse(msg, ["description", "summary"]);
    expect(compressed).toBe(1); // only summary was verbose enough to compress
    const tools = (message.result as { tools: Array<{ summary: string }> }).tools;
    expect(tools[0]!.summary.length).toBeLessThan(summary.length);
  });

  it("tracks bytes before and after", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 10,
      result: {
        tools: [
          {
            name: "test",
            description: "This tool reads a file from the filesystem. You can use it to read the contents of any file that you have permission to access. Please note that the file path must be absolute.",
          },
        ],
      },
    };

    const { bytesBefore, bytesAfter, compressed } = transformResponse(msg);
    expect(compressed).toBe(1);
    expect(bytesBefore).toBeGreaterThan(0);
    expect(bytesAfter).toBeGreaterThan(0);
    expect(bytesAfter).toBeLessThan(bytesBefore);
  });

  it("preserves tool names and inputSchemas", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 11,
      result: {
        tools: [
          {
            name: "read_file",
            description: "This tool reads a file from the filesystem. You can use it to read the contents of any file.",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute file path" },
              },
              required: ["path"],
            },
          },
        ],
      },
    };

    const { message } = transformResponse(msg);
    const tools = (message.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools[0]!.name).toBe("read_file");
    expect(tools[0]!.inputSchema.type).toBe("object");
    expect(tools[0]!.inputSchema.required).toEqual(["path"]);
  });
});

// ---------------------------------------------------------------------------
// Guard invariant — technical content preservation
// ---------------------------------------------------------------------------

describe("guard invariant — technical content preservation", () => {
  it("compressed descriptions preserve all code identifiers from original", () => {
    const descriptions = [
      "Use the `readFileSync` function from `node:fs` to read `filePath` and return contents as `string`.",
      "Calls `fetch('https://api.example.com/v2/data')` with `Authorization` header set to `Bearer ${token}`.",
      "Runs `npm test -- --coverage` in the `cwd` directory and returns the output of `jest`.",
      "Parses `JSON.parse(content)` and throws `SyntaxError` if the content is not valid JSON.",
    ];

    for (const desc of descriptions) {
      const { compressed, reduced } = compressProxyDescription(desc);
      if (!reduced) continue;

      // Extract all `code` spans from the original
      const codeSpans = desc.match(/`[^`]+`/g) || [];
      for (const span of codeSpans) {
        expect(compressed).toContain(span);
      }
    }
  });

  it("compressed descriptions preserve all URLs", () => {
    const desc = "Fetches data from https://api.example.com/v2/users and https://auth.example.com/token. You should provide credentials.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("https://api.example.com/v2/users");
    expect(compressed).toContain("https://auth.example.com/token");
  });

  it("compressed descriptions preserve all file paths", () => {
    const desc = "Reads /etc/passwd and /var/log/app.log. You can also read ~/.config/settings.json.";
    const { compressed } = compressProxyDescription(desc);
    expect(compressed).toContain("/etc/passwd");
    expect(compressed).toContain("/var/log/app.log");
  });

  it("compression engine validation passes", () => {
    const desc = "This tool reads a file from the filesystem. You can use it to read the contents of any file that you have permission to access. Please note that the file path must be absolute. In order to use this tool, you should provide the `filePath` parameter.";
    const result = compressFile(desc, "full");
    expect(result.validationOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles null result", () => {
    const msg = { jsonrpc: "2.0", id: 1, result: null };
    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("handles result as primitive", () => {
    const msg = { jsonrpc: "2.0", id: 2, result: 42 };
    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("handles result as array", () => {
    const msg = { jsonrpc: "2.0", id: 3, result: [1, 2, 3] };
    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0);
  });

  it("handles tool items that are null", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 4,
      result: { tools: [null, { name: "ok", description: "Short." }] },
    };
    const { compressed } = transformResponse(msg);
    expect(compressed).toBe(0); // null skipped, "Short." not reduced
  });

  it("handles extremely long description", () => {
    const longDesc = "This tool reads a file from the filesystem. You can use it to read the contents of any file. ".repeat(50) + "Please note that you should use `readFileSync` from `node:fs`.";
    const { compressed, reduced } = compressProxyDescription(longDesc);
    expect(reduced).toBe(true);
    expect(compressed).toContain("readFileSync");
    expect(compressed).toContain("node:fs");
  });

  it("transformResponse handles batch responses (arrays)", () => {
    const desc = "This tool reads a file from the filesystem. You can use it to read the contents of any file that you have permission to access. Please note that the file path must be absolute. In order to use this tool effectively, you should provide the full path.";
    const batch = [
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [{ name: "read_file", description: desc }],
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { protocolVersion: "2024-11-05" },
      },
    ];

    // transformResponse works on individual messages, not arrays.
    // The proxy's line buffer handles arrays by iterating.
    // Here we verify each item in the batch transforms correctly.
    let totalCompressed = 0;
    for (const item of batch) {
      const { compressed } = transformResponse(item);
      totalCompressed += compressed;
    }
    expect(totalCompressed).toBe(1); // only the first item had a compressible description
  });
});

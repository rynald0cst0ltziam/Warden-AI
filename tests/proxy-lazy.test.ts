/**
 * Tests for proxy lazy-loading mode and inputSchema compression.
 *
 * Verifies:
 *   1. Schema compression strips cosmetic fields, preserves validation constraints
 *   2. Schema compression compresses property descriptions
 *   3. Lazy-loading meta-tool definitions are well-formed
 *   4. Compact listing format matches each level (low, medium, high, max)
 *   5. cacheToolsFromListResponse extracts tools correctly
 *   6. buildLazyToolsListResponse replaces full catalog with 3 meta-tools
 *   7. handleListTools returns compact listing
 *   8. handleGetToolSchema returns full (optionally compressed) schema
 *   9. isMetaToolCall detects meta-tool calls
 *  10. rewriteInvokeToolCall rewrites meta-tool calls to standard tools/call
 *  11. transformResponse with compressSchema compresses inputSchemas
 *  12. Guard invariant: schema compression never removes validation constraints
 *  13. Edge cases: empty schemas, missing fields, nested structures, $ref preservation
 */

import { describe, it, expect } from "vitest";
import {
  compressInputSchema,
} from "../src/proxy/schema-compress.js";
import {
  buildMetaToolDefinitions,
  buildCompactListing,
  cacheToolsFromListResponse,
  buildLazyToolsListResponse,
  handleListTools,
  handleGetToolSchema,
  isMetaToolCall,
  rewriteInvokeToolCall,
  META_TOOLS,
  type CachedTool,
  type LazyLevel,
} from "../src/proxy/lazy.js";
import { transformResponse } from "../src/proxy/index.js";

// ---------------------------------------------------------------------------
// Schema compression
// ---------------------------------------------------------------------------

describe("compressInputSchema", () => {
  it("strips cosmetic fields (title, default, examples, $schema, $comment)", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Read File",
      description: "Reads a file from the filesystem.",
      type: "object",
      properties: {
        path: {
          type: "string",
          title: "File Path",
          description: "The absolute path to the file to read.",
          default: "/tmp",
          examples: ["/tmp/test.txt", "/home/user/file.json"],
          $comment: "Must be absolute",
        },
        encoding: {
          type: "string",
          default: "utf8",
          enum: ["utf8", "base64", "hex"],
        },
      },
      required: ["path"],
    };

    const result = compressInputSchema(schema);
    expect(result.reduced).toBe(true);
    expect(result.fieldsStripped).toBeGreaterThan(0);

    const s = result.schema as Record<string, unknown>;
    expect(s.$schema).toBeUndefined();
    expect(s.title).toBeUndefined();

    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.path.title).toBeUndefined();
    expect(props.path.default).toBeUndefined();
    expect(props.path.examples).toBeUndefined();
    expect(props.path.$comment).toBeUndefined();
    expect(props.encoding.default).toBeUndefined();
  });

  it("preserves validation constraints (type, required, enum, minimum, etc.)", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/" },
        count: { type: "integer", minimum: 0, maximum: 100 },
        mode: { type: "string", enum: ["read", "write", "append"] },
        items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, uniqueItems: true },
        flag: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            inner: { type: "string", minLength: 2 },
          },
          required: ["inner"],
          additionalProperties: false,
        },
      },
      required: ["path", "mode"],
      additionalProperties: false,
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;

    // All validation constraints must survive
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["path", "mode"]);
    expect(s.additionalProperties).toBe(false);

    expect(props.path.type).toBe("string");
    expect(props.path.minLength).toBe(1);
    expect(props.path.maxLength).toBe(4096);
    expect(props.path.pattern).toBe("^/");

    expect(props.count.type).toBe("integer");
    expect(props.count.minimum).toBe(0);
    expect(props.count.maximum).toBe(100);

    expect(props.mode.type).toBe("string");
    expect(props.mode.enum).toEqual(["read", "write", "append"]);

    expect(props.items.type).toBe("array");
    expect(props.items.minItems).toBe(1);
    expect(props.items.maxItems).toBe(100);
    expect(props.items.uniqueItems).toBe(true);

    expect(props.nested.type).toBe("object");
    const nestedProps = props.nested.properties as Record<string, Record<string, unknown>>;
    expect(nestedProps.inner.minLength).toBe(2);
    expect(props.nested.required).toEqual(["inner"]);
    expect(props.nested.additionalProperties).toBe(false);
  });

  it("compresses property descriptions using prose compression", () => {
    const schema = {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Please provide the absolute file path to the file that you want to read. In order to use this tool effectively, you should provide the full path.",
        },
      },
      required: ["path"],
    };

    const result = compressInputSchema(schema);
    expect(result.descriptionsCompressed).toBe(1);

    const s = result.schema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    const desc = props.path.description as string;
    expect(desc.length).toBeLessThan(schema.properties.path.description.length);
    // Technical content preserved
    expect(desc).toContain("file path");
  });

  it("preserves $ref and $defs when $defs are referenced", () => {
    const schema = {
      type: "object",
      properties: {
        item: { $ref: "#/$defs/Item" },
      },
      $defs: {
        Item: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    expect(s.$defs).toBeDefined();
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.item.$ref).toBe("#/$defs/Item");
  });

  it("strips unreferenced $defs and definitions", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      $defs: {
        Unused: { type: "string" },
      },
      definitions: {
        AlsoUnused: { type: "number" },
      },
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    expect(s.$defs).toBeUndefined();
    expect(s.definitions).toBeUndefined();
  });

  it("handles null, primitives, and arrays gracefully", () => {
    expect(compressInputSchema(null).reduced).toBe(false);
    expect(compressInputSchema(42).reduced).toBe(false);
    expect(compressInputSchema("string").reduced).toBe(false);
    expect(compressInputSchema([1, 2, 3]).reduced).toBe(false);
  });

  it("handles empty schema object", () => {
    const result = compressInputSchema({});
    expect(result.reduced).toBe(false);
  });

  it("handles deeply nested schemas", () => {
    const schema = {
      type: "object",
      properties: {
        level1: {
          type: "object",
          properties: {
            level2: {
              type: "object",
              properties: {
                level3: {
                  type: "object",
                  properties: {
                    value: {
                      type: "string",
                      title: "Deep Value",
                      default: "hello",
                      description: "Please provide the value that you want to set for this deeply nested property.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = compressInputSchema(schema);
    expect(result.reduced).toBe(true);
    expect(result.fieldsStripped).toBeGreaterThanOrEqual(2); // title + default
    expect(result.descriptionsCompressed).toBe(1);
  });

  it("preserves deprecated field", () => {
    const schema = {
      type: "object",
      properties: {
        old_method: {
          type: "string",
          deprecated: true,
          description: "This method is deprecated. Please use new_method instead.",
        },
      },
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.old_method.deprecated).toBe(true);
  });

  it("preserves oneOf, anyOf, allOf, not", () => {
    const schema = {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0 },
      ],
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
      allOf: [
        { type: "object" },
        { properties: { x: { type: "string" } } },
      ],
      not: { type: "null" },
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    expect(s.oneOf).toBeDefined();
    expect(s.anyOf).toBeDefined();
    expect(s.allOf).toBeDefined();
    expect(s.not).toBeDefined();
  });

  it("reduces byte size for verbose schemas", () => {
    const schema = {
      title: "Very Verbose Schema Title",
      $schema: "http://json-schema.org/draft-07/schema#",
      $comment: "This is a comment about the schema",
      type: "object",
      properties: {
        path: {
          type: "string",
          title: "File Path Title",
          description: "Please provide the absolute file path to the file that you want to read. In order to use this tool effectively, you should provide the full path. Please note that the file path must be absolute. Due to the fact that the tool reads the entire file, you should be careful with very large files.",
          default: "/tmp/default",
          examples: ["/tmp/test.txt", "/home/user/file.json", "/var/log/app.log"],
          readOnly: true,
        },
        content: {
          type: "string",
          title: "Content Title",
          description: "The content to write to the file. You should provide the content as a string. Please note that this will overwrite any existing content in the file.",
          writeOnly: true,
        },
      },
      required: ["path", "content"],
    };

    const result = compressInputSchema(schema);
    expect(result.reduced).toBe(true);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    const reduction = ((result.bytesBefore - result.bytesAfter) / result.bytesBefore) * 100;
    expect(reduction).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: meta-tool definitions
// ---------------------------------------------------------------------------

describe("buildMetaToolDefinitions", () => {
  it("returns exactly 3 meta-tools", () => {
    const tools = buildMetaToolDefinitions();
    expect(tools).toHaveLength(3);
  });

  it("meta-tools have correct names", () => {
    const tools = buildMetaToolDefinitions();
    expect(tools[0]!.name).toBe(META_TOOLS.listTools);
    expect(tools[1]!.name).toBe(META_TOOLS.getToolSchema);
    expect(tools[2]!.name).toBe(META_TOOLS.invokeTool);
  });

  it("meta-tools have valid inputSchemas", () => {
    const tools = buildMetaToolDefinitions();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("get_tool_schema requires a name parameter", () => {
    const tools = buildMetaToolDefinitions();
    const getSchema = tools.find((t) => t.name === META_TOOLS.getToolSchema)!;
    expect(getSchema.inputSchema.required).toContain("name");
  });

  it("invoke_tool requires a name parameter", () => {
    const tools = buildMetaToolDefinitions();
    const invoke = tools.find((t) => t.name === META_TOOLS.invokeTool)!;
    expect(invoke.inputSchema.required).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: compact listing
// ---------------------------------------------------------------------------

describe("buildCompactListing", () => {
  const tools: CachedTool[] = [
    {
      name: "read_file",
      description: "This tool reads a file from the filesystem. You can use it to read the contents of any file. Please note that the file path must be absolute.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          encoding: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Writes content to a file on the filesystem. You should provide the file path and the content to write.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  ];

  it("low level: name(args): full compressed description", () => {
    const listing = buildCompactListing(tools, "low");
    expect(listing).toContain("read_file");
    expect(listing).toContain("path");
    expect(listing).toContain("encoding");
    expect(listing).toContain("write_file");
    expect(listing).toContain("content");
    // Should contain description text (compressed)
    expect(listing).toContain("file");
  });

  it("medium level: name(args): first sentence", () => {
    const listing = buildCompactListing(tools, "medium");
    expect(listing).toContain("read_file(path, encoding)");
    expect(listing).toContain("write_file(path, content)");
    // First sentence only
    const lines = listing.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("high level: name(args) only, no description", () => {
    const listing = buildCompactListing(tools, "high");
    expect(listing).toContain("read_file(path, encoding)");
    expect(listing).toContain("write_file(path, content)");
    // Should NOT contain description text
    expect(listing).not.toContain("filesystem");
  });

  it("max level: just names, no args or description", () => {
    const listing = buildCompactListing(tools, "max");
    const lines = listing.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("read_file");
    expect(lines[1]).toBe("write_file");
    // No parentheses (no arg list)
    expect(listing).not.toContain("(");
  });

  it("handles empty tool list", () => {
    const listing = buildCompactListing([], "medium");
    expect(listing).toBe("");
  });

  it("handles tool with no properties in schema", () => {
    const tool: CachedTool = {
      name: "ping",
      description: "Returns pong.",
      inputSchema: { type: "object", properties: {} },
    };
    const listing = buildCompactListing([tool], "medium");
    expect(listing).toContain("ping()");
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: cacheToolsFromListResponse
// ---------------------------------------------------------------------------

describe("cacheToolsFromListResponse", () => {
  it("extracts tools from a tools/list response", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "read_file", description: "Read a file.", inputSchema: { type: "object" } },
          { name: "write_file", description: "Write a file.", inputSchema: { type: "object" } },
        ],
      },
    };

    const tools = cacheToolsFromListResponse(msg);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("read_file");
    expect(tools[0]!.description).toBe("Read a file.");
    expect(tools[1]!.name).toBe("write_file");
  });

  it("handles empty tools array", () => {
    const msg = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    expect(cacheToolsFromListResponse(msg)).toHaveLength(0);
  });

  it("handles missing tools array", () => {
    const msg = { jsonrpc: "2.0", id: 1, result: {} };
    expect(cacheToolsFromListResponse(msg)).toHaveLength(0);
  });

  it("handles tool without description", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "no_desc", inputSchema: {} }],
      },
    };
    const tools = cacheToolsFromListResponse(msg);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.description).toBe("");
  });

  it("handles tool without inputSchema", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "no_schema", description: "No schema." }],
      },
    };
    const tools = cacheToolsFromListResponse(msg);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.inputSchema).toEqual({});
  });

  it("handles null/invalid result", () => {
    expect(cacheToolsFromListResponse({ result: null })).toHaveLength(0);
    expect(cacheToolsFromListResponse({ result: 42 })).toHaveLength(0);
    expect(cacheToolsFromListResponse({ result: [1, 2] })).toHaveLength(0);
    expect(cacheToolsFromListResponse({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: buildLazyToolsListResponse
// ---------------------------------------------------------------------------

describe("buildLazyToolsListResponse", () => {
  it("returns a valid JSON-RPC response with 3 meta-tools", () => {
    const response = buildLazyToolsListResponse(1);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toEqual([
      META_TOOLS.listTools,
      META_TOOLS.getToolSchema,
      META_TOOLS.invokeTool,
    ]);
  });

  it("preserves string ids", () => {
    const response = buildLazyToolsListResponse("abc-123");
    expect(response.id).toBe("abc-123");
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: handleListTools
// ---------------------------------------------------------------------------

describe("handleListTools", () => {
  const tools: CachedTool[] = [
    {
      name: "read_file",
      description: "This tool reads a file from the filesystem. You can use it to read the contents of any file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "write_file",
      description: "Writes content to a file on the filesystem.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  ];

  it("returns a valid tools/call response with compact listing", () => {
    const response = handleListTools(1, tools, "medium");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    const result = response.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("read_file");
    expect(result.content[0]!.text).toContain("write_file");
  });

  it("respects the lazy level", () => {
    const lowResp = handleListTools(1, tools, "low");
    const maxResp = handleListTools(2, tools, "max");
    const lowText = (lowResp.result as { content: Array<{ text: string }> }).content[0]!.text;
    const maxText = (maxResp.result as { content: Array<{ text: string }> }).content[0]!.text;
    // Low level should be longer (includes descriptions)
    expect(lowText.length).toBeGreaterThan(maxText.length);
    // Max level should just have names
    expect(maxText.trim()).toBe("read_file\nwrite_file");
  });

  it("handles empty tool list", () => {
    const response = handleListTools(1, [], "medium");
    const text = (response.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: handleGetToolSchema
// ---------------------------------------------------------------------------

describe("handleGetToolSchema", () => {
  const tools: CachedTool[] = [
    {
      name: "read_file",
      description: "Read a file from the filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path.", title: "Path", default: "/tmp" },
        },
        required: ["path"],
      },
    },
  ];

  it("returns the full schema for a valid tool name", () => {
    const response = handleGetToolSchema(1, { name: "read_file" }, tools, false);
    expect(response.jsonrpc).toBe("2.0");
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("read_file");
    expect(result.content[0]!.text).toContain("File path.");
    // Original schema (not compressed)
    expect(result.content[0]!.text).toContain("Path");
    expect(result.content[0]!.text).toContain("/tmp");
  });

  it("returns compressed schema when compressSchema is true", () => {
    const response = handleGetToolSchema(1, { name: "read_file" }, tools, true);
    const text = (response.result as { content: Array<{ text: string }> }).content[0]!.text;
    // Compressed: title and default should be stripped
    expect(text).not.toContain('"Path"');
    expect(text).not.toContain('"/tmp"');
    // Validation constraint preserved
    expect(text).toContain('"required"');
    expect(text).toContain('"path"');
  });

  it("returns error for unknown tool name", () => {
    const response = handleGetToolSchema(1, { name: "nonexistent" }, tools, false);
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("returns error for missing name parameter", () => {
    const response = handleGetToolSchema(1, {}, tools, false);
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("name");
  });

  it("returns error for non-string name parameter", () => {
    const response = handleGetToolSchema(1, { name: 42 }, tools, false);
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: isMetaToolCall
// ---------------------------------------------------------------------------

describe("isMetaToolCall", () => {
  it("detects warden_list_tools calls", () => {
    const msg = { method: "tools/call", params: { name: "warden_list_tools" } };
    expect(isMetaToolCall(msg)).toBe(META_TOOLS.listTools);
  });

  it("detects warden_get_tool_schema calls", () => {
    const msg = { method: "tools/call", params: { name: "warden_get_tool_schema" } };
    expect(isMetaToolCall(msg)).toBe(META_TOOLS.getToolSchema);
  });

  it("detects warden_invoke_tool calls", () => {
    const msg = { method: "tools/call", params: { name: "warden_invoke_tool" } };
    expect(isMetaToolCall(msg)).toBe(META_TOOLS.invokeTool);
  });

  it("returns null for non-meta-tool calls", () => {
    const msg = { method: "tools/call", params: { name: "read_file" } };
    expect(isMetaToolCall(msg)).toBeNull();
  });

  it("returns null for non-tools/call methods", () => {
    const msg = { method: "tools/list" };
    expect(isMetaToolCall(msg)).toBeNull();
  });

  it("returns null for missing params", () => {
    expect(isMetaToolCall({ method: "tools/call" })).toBeNull();
    expect(isMetaToolCall({ method: "tools/call", params: null })).toBeNull();
    expect(isMetaToolCall({ method: "tools/call", params: "string" })).toBeNull();
  });

  it("returns null for non-string name", () => {
    const msg = { method: "tools/call", params: { name: 42 } };
    expect(isMetaToolCall(msg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lazy-loading: rewriteInvokeToolCall
// ---------------------------------------------------------------------------

describe("rewriteInvokeToolCall", () => {
  it("rewrites a warden_invoke_tool call to a standard tools/call", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: {
          name: "read_file",
          arguments: { path: "/tmp/test.txt" },
        },
      },
    };

    const rewritten = rewriteInvokeToolCall(msg);
    expect(rewritten).not.toBeNull();
    expect(rewritten!.params.name).toBe("read_file");
    expect(rewritten!.params.arguments).toEqual({ path: "/tmp/test.txt" });
    // Original id and method preserved
    expect(rewritten!.id).toBe(1);
    expect(rewritten!.method).toBe("tools/call");
  });

  it("handles invoke_tool call with no arguments field", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: {
          name: "ping",
        },
      },
    };

    const rewritten = rewriteInvokeToolCall(msg);
    expect(rewritten).not.toBeNull();
    expect(rewritten!.params.name).toBe("ping");
    expect(rewritten!.params.arguments).toEqual({});
  });

  it("returns null for missing tool name", () => {
    const msg = {
      method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: { arguments: {} },
      },
    };
    expect(rewriteInvokeToolCall(msg)).toBeNull();
  });

  it("returns null for non-string tool name", () => {
    const msg = {
      method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: { name: 42 },
      },
    };
    expect(rewriteInvokeToolCall(msg)).toBeNull();
  });

  it("returns null for missing params", () => {
    expect(rewriteInvokeToolCall({ method: "tools/call" })).toBeNull();
    expect(rewriteInvokeToolCall({ method: "tools/call", params: null })).toBeNull();
  });

  it("returns null for non-object arguments", () => {
    const msg = {
      method: "tools/call",
      params: {
        name: "warden_invoke_tool",
        arguments: "string",
      },
    };
    expect(rewriteInvokeToolCall(msg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformResponse with compressSchema
// ---------------------------------------------------------------------------

describe("transformResponse with compressSchema", () => {
  it("compresses inputSchemas when compressSchema is true", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "read_file",
            description: "This tool reads a file from the filesystem. You can use it to read the contents of any file.",
            inputSchema: {
              $schema: "http://json-schema.org/draft-07/schema#",
              title: "Read File",
              type: "object",
              properties: {
                path: {
                  type: "string",
                  title: "Path",
                  description: "Please provide the absolute file path to the file that you want to read.",
                  default: "/tmp",
                },
              },
              required: ["path"],
            },
          },
        ],
      },
    };

    const { schemasCompressed, schemaBytesBefore, schemaBytesAfter } =
      transformResponse(msg, ["description"], "full", false, true);

    expect(schemasCompressed).toBe(1);
    expect(schemaBytesAfter).toBeLessThan(schemaBytesBefore);

    // Verify cosmetic fields were stripped
    const tool = (msg.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools[0]!;
    expect(tool.inputSchema.$schema).toBeUndefined();
    expect(tool.inputSchema.title).toBeUndefined();
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.path.title).toBeUndefined();
    expect(props.path.default).toBeUndefined();
    // Validation constraint preserved
    expect(tool.inputSchema.required).toEqual(["path"]);
  });

  it("does not compress inputSchemas when compressSchema is false (default)", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "read_file",
            description: "Read a file.",
            inputSchema: {
              title: "Read File",
              type: "object",
              properties: {
                path: { type: "string", default: "/tmp" },
              },
              required: ["path"],
            },
          },
        ],
      },
    };

    const { schemasCompressed } = transformResponse(msg);
    expect(schemasCompressed).toBe(0);

    // Schema should be unchanged
    const tool = (msg.result as { tools: Array<{ inputSchema: Record<string, unknown> }> }).tools[0]!;
    expect(tool.inputSchema.title).toBe("Read File");
  });

  it("does not compress schemas for prompts or resources", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        prompts: [
          {
            name: "code_review",
            description: "Please review the following code carefully and provide detailed feedback.",
            inputSchema: { title: "Should Not Be Stripped", type: "object" },
          },
        ],
      },
    };

    const { schemasCompressed } = transformResponse(msg, ["description"], "full", false, true);
    // Schema compression only applies to tools, not prompts
    expect(schemasCompressed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Guard invariant: schema compression never removes validation constraints
// ---------------------------------------------------------------------------

describe("guard invariant — schema compression preserves validation", () => {
  it("complex schema with all constraint types survives compression", () => {
    const schema = {
      type: "object",
      properties: {
        str: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$", format: "path" },
        num: { type: "number", minimum: 0, maximum: 100, exclusiveMinimum: true, exclusiveMaximum: false },
        arr: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, uniqueItems: true },
        enum_val: { type: "string", enum: ["a", "b", "c"] },
        const_val: { const: 42 },
        flag: { type: "boolean" },
        date: { type: "string", format: "date-time", contentEncoding: "utf-8", contentMediaType: "text/plain" },
        obj: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 5,
        },
      },
      required: ["str", "num"],
      additionalProperties: true,
      minProperties: 2,
      maxProperties: 10,
    };

    const result = compressInputSchema(schema);
    const s = result.schema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;

    // Every validation constraint must survive
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["str", "num"]);
    expect(s.additionalProperties).toBe(true);
    expect(s.minProperties).toBe(2);
    expect(s.maxProperties).toBe(10);

    expect(props.str.type).toBe("string");
    expect(props.str.minLength).toBe(1);
    expect(props.str.maxLength).toBe(100);
    expect(props.str.pattern).toBe("^[a-z]+$");
    expect(props.str.format).toBe("path");

    expect(props.num.type).toBe("number");
    expect(props.num.minimum).toBe(0);
    expect(props.num.maximum).toBe(100);
    expect(props.num.exclusiveMinimum).toBe(true);
    expect(props.num.exclusiveMaximum).toBe(false);

    expect(props.arr.type).toBe("array");
    expect(props.arr.items).toEqual({ type: "string" });
    expect(props.arr.minItems).toBe(1);
    expect(props.arr.maxItems).toBe(10);
    expect(props.arr.uniqueItems).toBe(true);

    expect(props.enum_val.enum).toEqual(["a", "b", "c"]);
    expect(props.const_val.const).toBe(42);
    expect(props.flag.type).toBe("boolean");
    expect(props.date.format).toBe("date-time");
    expect(props.date.contentEncoding).toBe("utf-8");
    expect(props.date.contentMediaType).toBe("text/plain");

    expect(props.obj.type).toBe("object");
    expect(props.obj.required).toEqual(["x"]);
    expect(props.obj.additionalProperties).toBe(false);
    expect(props.obj.minProperties).toBe(1);
    expect(props.obj.maxProperties).toBe(5);
  });
});

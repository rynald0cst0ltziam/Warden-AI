/**
 * Lazy-loading / on-demand schema expansion for MCP proxy.
 *
 * Instead of forwarding the full tools/list response (which can contain dozens
 * or hundreds of tool definitions with full JSON-Schemas), the proxy caches
 * the full catalog and exposes a compact surface of meta-tools:
 *
 *   warden_list_tools      — returns a compact index of available tools
 *   warden_get_tool_schema — returns the full inputSchema for one tool
 *   warden_invoke_tool     — forwards a tools/call to the upstream
 *
 * This matches the pattern used by mcp-compressor (Atlassian) and mcp-slim
 * (dopatools), reducing initial context by 70-97% depending on the level.
 *
 * Compression levels (control how much metadata is in the compact listing):
 *   low    — name(arg1, arg2): full compressed description
 *   medium — name(arg1, arg2): first sentence of compressed description
 *   high   — name(arg1, arg2) — no description
 *   max    — just name — no args, no description
 *
 * The full inputSchema is never lost — it's cached and returned on demand via
 * warden_get_tool_schema. When --compress-schema is also enabled, the schema
 * returned by warden_get_tool_schema is compressed (cosmetic fields stripped,
 * descriptions compressed) to further reduce tokens.
 */

import { compressFile, type CompressLevel } from "../compress/index.js";
import { compressInputSchema } from "./schema-compress.js";

/** Lazy-loading compression level. */
export type LazyLevel = "low" | "medium" | "high" | "max";

/** A cached tool from the upstream's tools/list response. */
export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The three meta-tools exposed in lazy mode. */
export const META_TOOLS = {
  listTools: "warden_list_tools",
  getToolSchema: "warden_get_tool_schema",
  invokeTool: "warden_invoke_tool",
} as const;

/**
 * Build the compact meta-tool definitions that replace the upstream's
 * tools/list response in lazy mode.
 */
export function buildMetaToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: META_TOOLS.listTools,
      description:
        "List all available tools from the upstream server. Returns a compact index of tool names and short descriptions. Call this first to discover what tools are available.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: META_TOOLS.getToolSchema,
      description:
        "Get the full input schema for a specific tool by name. Call this after warden_list_tools to get the complete parameter definition before invoking the tool.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the tool to get the schema for.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: META_TOOLS.invokeTool,
      description:
        "Invoke a tool on the upstream server by name with the provided arguments. Use warden_get_tool_schema first to learn the expected parameters.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the tool to invoke.",
          },
          arguments: {
            type: "object",
            description: "The arguments to pass to the tool.",
            additionalProperties: true,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Extract argument names from a tool's inputSchema for the compact listing.
 * Returns a string like "(path, content, encoding)" or "()" if no properties.
 */
function extractArgList(inputSchema: Record<string, unknown>): string {
  const props = inputSchema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return "()";
  const names = Object.keys(props);
  if (names.length === 0) return "()";
  return `(${names.join(", ")})`;
}

/**
 * Get the first sentence of a description (up to the first period followed
 * by a space or end of string).
 */
function firstSentence(text: string): string {
  const match = text.match(/^[^.]*\./);
  return match ? match[0].trim() : text.trim();
}

/**
 * Build the compact tool index text returned by warden_list_tools.
 * Format depends on the lazy level.
 */
export function buildCompactListing(
  tools: CachedTool[],
  level: LazyLevel,
  compressLevel: CompressLevel = "full",
): string {
  const lines: string[] = [];

  for (const tool of tools) {
    // Compress the description first (all levels get compressed prose)
    let desc = tool.description;
    if (desc && level !== "max") {
      const compressed = compressFile(desc, compressLevel);
      if (compressed.validationOk && compressed.compressed.length < desc.length) {
        desc = compressed.compressed.trim();
      }
    }

    let line: string;
    switch (level) {
      case "low":
        // name(args): full compressed description
        line = `${tool.name}${extractArgList(tool.inputSchema)}: ${desc}`;
        break;
      case "medium":
        // name(args): first sentence of compressed description
        line = `${tool.name}${extractArgList(tool.inputSchema)}: ${firstSentence(desc)}`;
        break;
      case "high":
        // name(args) — no description
        line = `${tool.name}${extractArgList(tool.inputSchema)}`;
        break;
      case "max":
        // just name — no args, no description
        line = tool.name;
        break;
      default:
        line = `${tool.name}: ${desc}`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Cache tools from an upstream tools/list response.
 * Returns the array of cached tools (name, description, inputSchema).
 */
export function cacheToolsFromListResponse(
  msg: Record<string, unknown>,
): CachedTool[] {
  const result = msg.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];

  const cached: CachedTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const t = tool as Record<string, unknown>;
    const name = t.name;
    if (typeof name !== "string") continue;
    cached.push({
      name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
          ? (t.inputSchema as Record<string, unknown>)
          : {},
    });
  }
  return cached;
}

/**
 * Build the tools/list response to send to the client in lazy mode.
 * Replaces the upstream's full tool list with the 3 meta-tools.
 */
export function buildLazyToolsListResponse(
  id: string | number,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: buildMetaToolDefinitions(),
    },
  };
}

/**
 * Handle a warden_list_tools meta-tool call.
 * Returns the compact listing as a tools/call response.
 */
export function handleListTools(
  id: string | number,
  tools: CachedTool[],
  level: LazyLevel,
  compressLevel: CompressLevel = "full",
): Record<string, unknown> {
  const listing = buildCompactListing(tools, level, compressLevel);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: listing }],
      isError: false,
    },
  };
}

/**
 * Handle a warden_get_tool_schema meta-tool call.
 * Returns the full (optionally compressed) inputSchema for the requested tool.
 * Returns an error if the tool name is not found.
 */
export function handleGetToolSchema(
  id: string | number,
  args: Record<string, unknown>,
  tools: CachedTool[],
  compressSchema: boolean,
  schemaCompressLevel: CompressLevel = "full",
): Record<string, unknown> {
  const name = args.name;
  if (typeof name !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Error: 'name' parameter is required." }],
        isError: true,
      },
    };
  }

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Error: Tool "${name}" not found. Call warden_list_tools to see available tools.` }],
        isError: true,
      },
    };
  }

  let schema = tool.inputSchema;
  if (compressSchema) {
    const result = compressInputSchema(tool.inputSchema, schemaCompressLevel);
    schema = result.schema as Record<string, unknown>;
  }

  // Return the schema as a text block containing the JSON, plus the full
  // description. This matches mcp-compressor's format.
  const text = `${tool.name}: ${tool.description}\n\n${JSON.stringify(schema, null, 2)}`;

  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError: false,
    },
  };
}

/**
 * Check if a tools/call request is targeting one of our meta-tools.
 * Returns the meta-tool name if it is, null otherwise.
 */
export function isMetaToolCall(
  msg: Record<string, unknown>,
): string | null {
  if (msg.method !== "tools/call") return null;
  const params = msg.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== "string") return null;
  if (name === META_TOOLS.listTools) return META_TOOLS.listTools;
  if (name === META_TOOLS.getToolSchema) return META_TOOLS.getToolSchema;
  if (name === META_TOOLS.invokeTool) return META_TOOLS.invokeTool;
  return null;
}

/**
 * Rewrite a warden_invoke_tool meta-tool call into a standard tools/call
 * request for the upstream server.
 *
 * The meta-tool call has:
 *   params.name = "warden_invoke_tool"
 *   params.arguments = { name: "actual_tool", arguments: { ... } }
 *
 * The rewritten request has:
 *   params.name = "actual_tool"
 *   params.arguments = { ... }
 *
 * Returns the rewritten message, or null if the call is malformed.
 */
export function rewriteInvokeToolCall(
  msg: Record<string, unknown>,
): Record<string, unknown> | null {
  const params = msg.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const args = (params as Record<string, unknown>).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const toolName = a.name;
  if (typeof toolName !== "string") return null;
  const toolArgs = a.arguments;
  if (toolArgs !== undefined && typeof toolArgs !== "object") return null;

  return {
    ...msg,
    params: {
      name: toolName,
      arguments: toolArgs ?? {},
    },
  };
}

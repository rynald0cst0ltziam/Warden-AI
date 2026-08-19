/**
 * Warden MCP Proxy — stdio middleware that compresses tool descriptions
 * from upstream MCP servers.
 *
 * Acts as a transparent proxy between an MCP client (Claude Code, Cursor,
 * Windsurf, etc.) and an upstream MCP server:
 *
 *   Agent ←→ Warden (proxy) ←→ [upstream MCP server]
 *
 * What it does:
 *   - Spawns the upstream MCP server as a subprocess
 *   - Intercepts tools/list, prompts/list, resources/list responses
 *   - Compresses description fields using Warden's compression engine
 *   - Verifies compressed descriptions preserve technical identifiers
 *   - Optionally compresses inputSchema JSON-Schemas (strip cosmetic fields,
 *     compress property descriptions) — opt-in via --compress-schema
 *   - Optionally prunes tools/call response content behind the trust guard
 *     (opt-in) — every kept line is verbatim from the raw, never rewritten
 *   - Optionally replaces the full tool catalog with 3 lazy-loading meta-tools
 *     (warden_list_tools, warden_get_tool_schema, warden_invoke_tool) so the
 *     client sees a tiny surface and loads schemas on demand — opt-in via --lazy
 *   - Forwards all other messages unchanged (both directions)
 *
 * What it deliberately does NOT do:
 *   - Modify request payloads going TO the upstream server (except
 *     warden_invoke_tool rewrites in lazy mode, which are transparent)
 *   - Multi-server aggregation (single upstream only for now)
 *
 * Tool-call response pruning is the one thing description-only compressors
 * (e.g. caveman-shrink) refuse to do, because rewriting a tool's output is
 * unsafe. Warden can do it safely because the trust guard enforces that the
 * pruned output is a verbatim subsequence of the raw — lines are removed,
 * never altered. It is opt-in and defaults OFF.
 *
 * Lazy-loading mode replaces the full tool catalog with 3 meta-tools, matching
 * the pattern used by mcp-compressor (Atlassian) and mcp-slim (dopatools).
 * The full schemas are cached and returned on demand via warden_get_tool_schema.
 * This reduces initial context by 70-97% depending on the level.
 *
 * Configuration (env vars):
 *   WARDEN_PROXY_FIELDS       comma-separated field names to compress
 *                             (default: description)
 *   WARDEN_PROXY_DEBUG=1      log compression deltas to stderr
 *   WARDEN_PROXY_PRUNE_RESPONSES=1  also prune tools/call response content
 *                             (guard-verified, removal-only; default off)
 *   WARDEN_PROXY_LEVEL        compression level: lite, full, ultra (default: full)
 *   WARDEN_PROXY_LAZY=1       enable lazy-loading mode (default off)
 *   WARDEN_PROXY_LAZY_LEVEL   lazy listing level: low, medium, high, max (default: medium)
 *   WARDEN_PROXY_COMPRESS_SCHEMA=1  compress inputSchema JSON-Schemas (default off)
 *
 * Usage:
 *   warden proxy <upstream-command> [...args]
 *
 * Example wrapping the filesystem MCP server:
 *   "mcpServers": {
 *     "fs-shrunk": {
 *       "command": "warden",
 *       "args": ["proxy", "npx", "@modelcontextprotocol/server-filesystem", "/path"]
 *     }
 *   }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { createLineBuffer, type ParsedMessage } from "./line-buffer.js";
import { getSpawnInvocation, getSpawnOptions, type SpawnInvocation } from "./spawn.js";
import { compressFile, type CompressLevel } from "../compress/index.js";
import { PruningEngine } from "../pruner/index.js";
import { logger } from "../logging/index.js";
import {
  compressInputSchema,
  type SchemaCompressResult,
} from "./schema-compress.js";
import {
  cacheToolsFromListResponse,
  buildLazyToolsListResponse,
  handleListTools,
  handleGetToolSchema,
  isMetaToolCall,
  rewriteInvokeToolCall,
  META_TOOLS,
  type CachedTool,
  type LazyLevel,
} from "./lazy.js";

/** Fields to compress in list responses. */
const DEFAULT_FIELDS = ["description"];
/** Array names in JSON-RPC responses that contain tool/prompt/resource lists. */
const LIST_ARRAYS = ["tools", "prompts", "resources", "resourceTemplates"];

/** Result of a proxy run — for testing and stats. */
export interface ProxyResult {
  messagesProcessed: number;
  descriptionsCompressed: number;
  bytesBefore: number;
  bytesAfter: number;
  /** tools/call response content blocks pruned (0 unless pruneResponses). */
  responseBlocksPruned: number;
  /** Bytes of tool-call response content before pruning. */
  responseBytesBefore: number;
  /** Bytes of tool-call response content after pruning. */
  responseBytesAfter: number;
  /** Number of inputSchemas compressed (0 unless compressSchema). */
  schemasCompressed: number;
  /** Bytes of inputSchemas before compression. */
  schemaBytesBefore: number;
  /** Bytes of inputSchemas after compression. */
  schemaBytesAfter: number;
  /** Number of tools cached for lazy loading (0 unless lazy mode). */
  toolsCached: number;
  /** Number of meta-tool calls handled locally (0 unless lazy mode). */
  metaToolCallsHandled: number;
  upstreamExitCode: number | null;
  upstreamSignal: string | null;
}

/**
 * Compress a description string using Warden's compression engine.
 * Returns the compressed string, or the original if compression failed
 * validation or didn't reduce size.
 */
export function compressProxyDescription(
  description: string,
  level: CompressLevel = "full",
): { compressed: string; reduced: boolean; beforeBytes: number; afterBytes: number } {
  const beforeBytes = Buffer.byteLength(description, "utf8");
  const result = compressFile(description, level);
  if (!result.validationOk) {
    return { compressed: description, reduced: false, beforeBytes, afterBytes: beforeBytes };
  }
  const compressed = result.compressed.trim();
  const afterBytes = Buffer.byteLength(compressed, "utf8");
  // Only claim reduction if the compressed string is actually shorter
  if (afterBytes >= beforeBytes) {
    return { compressed: description, reduced: false, beforeBytes, afterBytes: beforeBytes };
  }
  return { compressed, reduced: true, beforeBytes, afterBytes };
}

/**
 * Transform a JSON-RPC response message by compressing description fields
 * in tools/list, prompts/list, resources/list responses. Optionally also
 * compresses inputSchema JSON-Schemas.
 * Returns the modified message object, or the original if no changes were made.
 */
export function transformResponse(
  msg: Record<string, unknown>,
  fields: string[] = DEFAULT_FIELDS,
  level: CompressLevel = "full",
  debug = false,
  compressSchema = false,
): {
  message: Record<string, unknown>;
  compressed: number;
  bytesBefore: number;
  bytesAfter: number;
  schemasCompressed: number;
  schemaBytesBefore: number;
  schemaBytesAfter: number;
} {
  if (!msg.result || typeof msg.result !== "object") {
    return { message: msg, compressed: 0, bytesBefore: 0, bytesAfter: 0, schemasCompressed: 0, schemaBytesBefore: 0, schemaBytesAfter: 0 };
  }

  const result = msg.result as Record<string, unknown>;
  let compressedCount = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  let schemasCompressed = 0;
  let schemaBytesBefore = 0;
  let schemaBytesAfter = 0;

  for (const arrayName of LIST_ARRAYS) {
    const arr = result[arrayName];
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      // Compress description fields
      for (const field of fields) {
        if (typeof obj[field] !== "string") continue;
        const original = obj[field] as string;
        const { compressed, reduced, beforeBytes, afterBytes } =
          compressProxyDescription(original, level);

        if (reduced) {
          obj[field] = compressed;
          compressedCount++;
          totalBefore += beforeBytes;
          totalAfter += afterBytes;
          if (debug) {
            const name = (obj.name as string) || "?";
            logger.debug("proxy compressed description", {
              array: arrayName,
              tool: name,
              field,
              before: beforeBytes,
              after: afterBytes,
              reduction: `${(((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1)}%`,
            });
          }
        }
      }

      // Compress inputSchema (only for tools, not prompts/resources)
      if (compressSchema && arrayName === "tools" && obj.inputSchema && typeof obj.inputSchema === "object") {
        const sc = compressInputSchema(obj.inputSchema, level);
        if (sc.reduced) {
          obj.inputSchema = sc.schema;
          schemasCompressed++;
          schemaBytesBefore += sc.bytesBefore;
          schemaBytesAfter += sc.bytesAfter;
          if (debug) {
            const name = (obj.name as string) || "?";
            logger.debug("proxy compressed inputSchema", {
              tool: name,
              before: sc.bytesBefore,
              after: sc.bytesAfter,
              fieldsStripped: sc.fieldsStripped,
              descriptionsCompressed: sc.descriptionsCompressed,
              reduction: `${(((sc.bytesBefore - sc.bytesAfter) / sc.bytesBefore) * 100).toFixed(1)}%`,
            });
          }
        }
      }
    }
  }

  return {
    message: msg,
    compressed: compressedCount,
    bytesBefore: totalBefore,
    bytesAfter: totalAfter,
    schemasCompressed,
    schemaBytesBefore,
    schemaBytesAfter,
  };
}

/**
 * Prune the content of a tools/call response using Warden's pruning engine.
 *
 * Unlike description compression (which rewrites prose), this runs the raw
 * tool output through the pruning engine, whose trust guard guarantees the
 * pruned output is a VERBATIM subsequence of the raw — lines are removed,
 * never altered. If the guard fails or nothing was removed, the original text
 * is left untouched. This is why it is safe where prose compression is not.
 *
 * Only `text` content blocks are considered. The message is mutated in place
 * and also returned. Callers must have already confirmed this response is for
 * a tools/call request (JSON-RPC responses carry no method name).
 */
export function pruneToolCallResult(
  msg: Record<string, unknown>,
  engine: PruningEngine,
  debug = false,
): { message: Record<string, unknown>; blocksPruned: number; bytesBefore: number; bytesAfter: number } {
  const result = msg.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { message: msg, blocksPruned: 0, bytesBefore: 0, bytesAfter: 0 };
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return { message: msg, blocksPruned: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  let blocksPruned = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "text" || typeof b.text !== "string") continue;

    const original = b.text as string;
    const pr = engine.prune({
      toolType: "generic",
      rawOutput: original,
      task: { type: "unknown", relevanceHint: "", userMessage: "", toolName: null },
    });

    // The engine enforces the trust guard and never-worse check internally.
    // Only apply when the guard passed AND something was actually removed.
    if (pr.guardOk && pr.prunedOutput.length < original.length) {
      b.text = pr.prunedOutput;
      const before = Buffer.byteLength(original, "utf8");
      const after = Buffer.byteLength(pr.prunedOutput, "utf8");
      blocksPruned++;
      bytesBefore += before;
      bytesAfter += after;
      if (debug) {
        logger.debug("proxy pruned tool-call response", {
          ruleId: pr.ruleId,
          before,
          after,
          reduction: `${(((before - after) / before) * 100).toFixed(1)}%`,
        });
      }
    }
  }

  return { message: msg, blocksPruned, bytesBefore, bytesAfter };
}

/**
 * Run the MCP proxy. Spawns the upstream server, pipes stdio bidirectionally,
 * and compresses description fields in list responses.
 *
 * Options:
 *   - lazy:           Replace full tool catalog with 3 meta-tools (lazy loading)
 *   - lazyLevel:      Compact listing level: low, medium, high, max (default: medium)
 *   - compressSchema: Strip cosmetic JSON-Schema fields + compress descriptions
 *   - pruneResponses: Prune tools/call response content behind trust guard
 *
 * This function takes over the process's stdin/stdout — it's meant to be
 * called from the CLI entry point, not from application code.
 */
export async function runProxy(
  upstreamCommand: string,
  upstreamArgs: string[],
  opts: {
    fields?: string[];
    debug?: boolean;
    level?: CompressLevel;
    /** Prune tools/call response content behind the trust guard (opt-in). */
    pruneResponses?: boolean;
    /** Enable lazy-loading mode: replace tool catalog with meta-tools (opt-in). */
    lazy?: boolean;
    /** Lazy listing level: low, medium, high, max (default: medium). */
    lazyLevel?: LazyLevel;
    /** Compress inputSchema JSON-Schemas (opt-in). */
    compressSchema?: boolean;
  } = {},
): Promise<ProxyResult> {
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const debug = opts.debug ?? process.env.WARDEN_PROXY_DEBUG === "1";
  const level = opts.level ?? (process.env.WARDEN_PROXY_LEVEL as CompressLevel) ?? "full";
  const pruneResponses =
    opts.pruneResponses ?? process.env.WARDEN_PROXY_PRUNE_RESPONSES === "1";
  const lazy = opts.lazy ?? process.env.WARDEN_PROXY_LAZY === "1";
  const lazyLevel = opts.lazyLevel ?? (process.env.WARDEN_PROXY_LAZY_LEVEL as LazyLevel) ?? "medium";
  const compressSchema =
    opts.compressSchema ?? process.env.WARDEN_PROXY_COMPRESS_SCHEMA === "1";
  const engine = pruneResponses ? new PruningEngine() : null;

  let invocation: SpawnInvocation;
  try {
    invocation = getSpawnInvocation(upstreamCommand, upstreamArgs);
  } catch (err) {
    process.stderr.write(`warden proxy: failed to resolve upstream: ${String(err)}\n`);
    process.exit(1);
  }

  const upstream: ChildProcess = spawn(
    invocation.command,
    invocation.args,
    getSpawnOptions(),
  );

  let spawnFailed = false;
  let messagesProcessed = 0;
  let descriptionsCompressed = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;
  let responseBlocksPruned = 0;
  let responseBytesBefore = 0;
  let responseBytesAfter = 0;
  let schemasCompressed = 0;
  let schemaBytesBefore = 0;
  let schemaBytesAfter = 0;
  let toolsCached = 0;
  let metaToolCallsHandled = 0;
  let closed = false;
  let stdinDrainListener: (() => void) | null = null;
  let stdoutDrainListener: (() => void) | null = null;

  // --- Lazy mode state ---
  let cachedTools: CachedTool[] = [];
  // Track which request ids are tools/list (to intercept their responses).
  const pendingToolsList = new Set<string | number>();
  // Track request ids whose method is "tools/call" (for response pruning).
  const pendingToolCalls = new Map<string | number, true>();
  const MAX_PENDING = 1000;

  function trackToolCall(id: string | number): void {
    if (pendingToolCalls.size >= MAX_PENDING) {
      const oldest = pendingToolCalls.keys().next().value;
      if (oldest !== undefined) pendingToolCalls.delete(oldest);
    }
    pendingToolCalls.set(id, true);
  }

  /**
   * Handle a meta-tool call locally (lazy mode).
   * For warden_list_tools and warden_get_tool_schema: sends response directly.
   * For warden_invoke_tool: rewrites and forwards to upstream.
   */
  function handleMetaToolCall(
    req: Record<string, unknown>,
    metaTool: string,
  ): void {
    const id = req.id;
    if (typeof id !== "string" && typeof id !== "number") return;

    const params = req.params as Record<string, unknown> | undefined;
    const args = (params?.arguments as Record<string, unknown>) ?? {};

    if (metaTool === META_TOOLS.invokeTool) {
      // Rewrite to standard tools/call and forward to upstream
      const rewritten = rewriteInvokeToolCall(req);
      if (!rewritten) {
        writeClient(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "Error: malformed warden_invoke_tool call. Expected { name: string, arguments: object }." }],
            isError: true,
          },
        }) + "\n");
        return;
      }
      trackToolCall(id);
      writeToUpstream(JSON.stringify(rewritten) + "\n");
      return; // Response will come from upstream
    }

    // warden_list_tools or warden_get_tool_schema — handle locally
    const response = metaTool === META_TOOLS.listTools
      ? handleListTools(id, cachedTools, lazyLevel, level)
      : handleGetToolSchema(id, args, cachedTools, compressSchema, level);

    metaToolCallsHandled++;
    writeClient(JSON.stringify(response) + "\n");
  }

  /**
   * Process a single client request (from stdin).
   * Returns true if the request was handled locally (meta-tool or tracked),
   * false if it should be forwarded to upstream.
   * In lazy mode, tools/list is forwarded (we need upstream's response to cache),
   * but meta-tool calls are handled locally and not forwarded.
   */
  function processClientRequest(req: Record<string, unknown>): boolean {
    const method = req.method;
    const id = req.id;

    if (lazy) {
      // Track tools/list requests so we can intercept their responses
      if (method === "tools/list") {
        if (typeof id === "string" || typeof id === "number") {
          pendingToolsList.add(id);
        }
        return false; // Forward to upstream — we need the response
      }

      // Intercept meta-tool calls
      const metaTool = isMetaToolCall(req);
      if (metaTool) {
        handleMetaToolCall(req, metaTool);
        return true; // Handled locally — don't forward
      }
    }

    // Track tools/call for response pruning
    if (pruneResponses && method === "tools/call") {
      if (typeof id === "string" || typeof id === "number") {
        trackToolCall(id);
      }
    }

    return false; // Forward to upstream
  }

  /**
   * Process a parsed client message (could be single or batch).
   * Returns the JSON string to forward to upstream, or null if nothing to forward.
   */
  function processClientMessage(json: Record<string, unknown> | unknown[]): string | null {
    if (Array.isArray(json)) {
      // Batch request — process each item, filter out locally-handled ones
      const remaining: unknown[] = [];
      for (const item of json) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const handled = processClientRequest(item as Record<string, unknown>);
          if (!handled) remaining.push(item);
        } else {
          remaining.push(item);
        }
      }
      if (remaining.length === 0) return null;
      return JSON.stringify(remaining);
    }

    // Single request
    const handled = processClientRequest(json);
    if (handled) return null;
    return JSON.stringify(json);
  }

  /**
   * Process a single upstream response object.
   * Returns true if the response was already written to the client (lazy
   * tools/list interception), false if the caller should write it.
   */
  function handleResponseObj(obj: Record<string, unknown>): boolean {
    // Lazy mode: intercept tools/list responses
    if (lazy) {
      const id = obj.id;
      if ((typeof id === "string" || typeof id === "number") && pendingToolsList.has(id)) {
        pendingToolsList.delete(id);
        // Cache the tools from the upstream response
        cachedTools = cacheToolsFromListResponse(obj);
        toolsCached = cachedTools.length;
        if (debug) {
          logger.debug("proxy lazy mode: cached tools from upstream", {
            count: cachedTools.length,
          });
        }
        // Replace the response with the meta-tool surface
        const lazyResponse = buildLazyToolsListResponse(id);
        writeClient(JSON.stringify(lazyResponse) + "\n");
        return true; // Already written — caller should not write
      }
    }

    // Compress descriptions and (optionally) schemas
    const t = transformResponse(obj, fields, level, debug, compressSchema);
    descriptionsCompressed += t.compressed;
    totalBytesBefore += t.bytesBefore;
    totalBytesAfter += t.bytesAfter;
    schemasCompressed += t.schemasCompressed;
    schemaBytesBefore += t.schemaBytesBefore;
    schemaBytesAfter += t.schemaBytesAfter;

    // Optionally prune tools/call response content
    if (pruneResponses && engine) {
      const id = obj.id;
      if ((typeof id === "string" || typeof id === "number") && pendingToolCalls.has(id)) {
        pendingToolCalls.delete(id);
        const pr = pruneToolCallResult(obj, engine, debug);
        responseBlocksPruned += pr.blocksPruned;
        responseBytesBefore += pr.bytesBefore;
        responseBytesAfter += pr.bytesAfter;
      }
    }

    return false; // Caller should write
  }

  upstream.on("error", (err) => {
    spawnFailed = true;
    process.stderr.write(`warden proxy: failed to spawn upstream: ${err.message}\n`);
    try { upstream.kill(); } catch { /* already dead */ }
  });

  // --- Upstream → Client (transform responses) ---
  const responses = createLineBuffer((msg: ParsedMessage) => {
    if (!msg.parsed) {
      writeClient(msg.raw + "\n");
      return;
    }

    messagesProcessed++;

    if (Array.isArray(msg.json)) {
      // Batch response — process each item
      const toWrite: unknown[] = [];
      for (const item of msg.json) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const alreadyWritten = handleResponseObj(item as Record<string, unknown>);
          if (!alreadyWritten) toWrite.push(item);
        } else {
          toWrite.push(item);
        }
      }
      // Write remaining (non-intercepted) items as a batch
      if (toWrite.length > 0) {
        writeClient(JSON.stringify(toWrite) + "\n");
      }
    } else if (msg.json.result !== undefined) {
      // Single response
      const obj = msg.json as Record<string, unknown>;
      const alreadyWritten = handleResponseObj(obj);
      if (!alreadyWritten) {
        writeClient(JSON.stringify(obj) + "\n");
      }
    } else {
      // Notifications, errors, etc. — pass through unchanged
      writeClient(JSON.stringify(msg.json) + "\n");
    }
  });

  upstream.stdout!.on("data", (chunk: Buffer) => {
    responses.push(chunk);
  });

  upstream.stdout!.on("end", () => {
    responses.end();
  });

  // --- Client → Upstream (with lazy interception) ---
  function forwardInput(chunk: Buffer): void {
    if (closed || !upstream.stdin?.writable) return;

    // If no interception features are enabled, pass through directly
    if (!lazy && !pruneResponses) {
      writeToUpstream(chunk.toString("utf8"));
      return;
    }

    // Parse each line, intercept as needed, forward the rest
    const text = chunk.toString("utf8");
    const lines = text.split("\n");
    const forwardLines: string[] = [];

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let parsed: Record<string, unknown> | unknown[] | null = null;
      try {
        const json = JSON.parse(line);
        if (json && typeof json === "object") {
          parsed = json;
        }
      } catch {
        // Not JSON — forward as-is
        forwardLines.push(line);
        continue;
      }

      if (!parsed) {
        forwardLines.push(line);
        continue;
      }

      const fwd = processClientMessage(parsed);
      if (fwd !== null) {
        forwardLines.push(fwd);
      }
    }

    if (forwardLines.length > 0) {
      writeToUpstream(forwardLines.join("\n") + "\n");
    }
  }

  /** Write data to upstream stdin with backpressure handling. */
  function writeToUpstream(data: string): void {
    if (closed || !upstream.stdin?.writable) return;
    if (!upstream.stdin.write(data)) {
      process.stdin.pause();
      stdinDrainListener = (): void => {
        upstream.stdin?.removeListener("drain", stdinDrainListener!);
        stdinDrainListener = null;
        if (!closed) process.stdin.resume();
      };
      upstream.stdin.once("drain", stdinDrainListener);
    }
  }

  function endInput(): void {
    if (upstream.stdin?.writable && !closed) {
      upstream.stdin.end();
    }
  }

  upstream.stdin?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && !spawnFailed) {
      process.stderr.write(`warden proxy: upstream stdin failed: ${err.message}\n`);
      process.exitCode = 1;
    }
  });

  process.stdin.on("data", forwardInput);
  process.stdin.on("end", endInput);

  // --- Backpressure handling ---
  function writeClient(data: string): void {
    if (closed) return;
    if (process.stdout.write(data)) return;
    upstream.stdout?.pause();
    stdoutDrainListener = (): void => {
      process.stdout.removeListener("drain", stdoutDrainListener!);
      stdoutDrainListener = null;
      if (!closed) upstream.stdout?.resume();
    };
    process.stdout.once("drain", stdoutDrainListener);
  }

  // --- Cleanup + wait for upstream to exit ---
  function cleanup(): void {
    if (closed) return;
    closed = true;
    process.stdin.pause();
    process.stdin.removeListener("data", forwardInput);
    process.stdin.removeListener("end", endInput);
    if (stdinDrainListener) upstream.stdin?.removeListener("drain", stdinDrainListener);
    if (stdoutDrainListener) process.stdout.removeListener("drain", stdoutDrainListener);
  }

  return new Promise((resolve) => {
    upstream.on("close", (code, signal) => {
      cleanup();

      if (spawnFailed) {
        process.exitCode = 1;
      } else if (signal) {
        const sigNum = osConstants.signals[signal as keyof typeof osConstants.signals];
        process.exitCode = 128 + (sigNum || 1);
      } else {
        process.exitCode = code || 0;
      }

      resolve({
        messagesProcessed,
        descriptionsCompressed,
        bytesBefore: totalBytesBefore,
        bytesAfter: totalBytesAfter,
        responseBlocksPruned,
        responseBytesBefore,
        responseBytesAfter,
        schemasCompressed,
        schemaBytesBefore,
        schemaBytesAfter,
        toolsCached,
        metaToolCallsHandled,
        upstreamExitCode: code,
        upstreamSignal: signal,
      });
    });
  });
}

// Re-export for external use
export { getSpawnInvocation, getSpawnOptions } from "./spawn.js";
export { createLineBuffer, type ParsedMessage } from "./line-buffer.js";
export type { SpawnInvocation } from "./spawn.js";
export { compressInputSchema, type SchemaCompressResult } from "./schema-compress.js";
export {
  cacheToolsFromListResponse,
  buildLazyToolsListResponse,
  buildMetaToolDefinitions,
  buildCompactListing,
  handleListTools,
  handleGetToolSchema,
  isMetaToolCall,
  rewriteInvokeToolCall,
  META_TOOLS,
  type CachedTool,
  type LazyLevel,
} from "./lazy.js";

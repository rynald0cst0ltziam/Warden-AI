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
 *   - Forwards all other messages unchanged (both directions)
 *
 * What it deliberately does NOT do (v1):
 *   - Compress tools/call response content (high risk of breaking parsing)
 *   - Modify request payloads going TO the upstream server
 *   - Multi-server aggregation (single upstream only for now)
 *
 * Configuration (env vars):
 *   WARDEN_PROXY_FIELDS       comma-separated field names to compress
 *                             (default: description)
 *   WARDEN_PROXY_DEBUG=1      log compression deltas to stderr
 *   WARDEN_PROXY_COMPRESS_OUTPUTS=1  also compress tools/call responses
 *   WARDEN_PROXY_LEVEL        compression level: lite, full, ultra (default: full)
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
import { logger } from "../logging/index.js";

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
 * in tools/list, prompts/list, resources/list responses.
 * Returns the modified message object, or the original if no changes were made.
 */
export function transformResponse(
  msg: Record<string, unknown>,
  fields: string[] = DEFAULT_FIELDS,
  level: CompressLevel = "full",
  debug = false,
): { message: Record<string, unknown>; compressed: number; bytesBefore: number; bytesAfter: number } {
  if (!msg.result || typeof msg.result !== "object") {
    return { message: msg, compressed: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  const result = msg.result as Record<string, unknown>;
  let compressedCount = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  for (const arrayName of LIST_ARRAYS) {
    const arr = result[arrayName];
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

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
    }
  }

  return { message: msg, compressed: compressedCount, bytesBefore: totalBefore, bytesAfter: totalAfter };
}

/**
 * Run the MCP proxy. Spawns the upstream server, pipes stdio bidirectionally,
 * and compresses description fields in list responses.
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
  } = {},
): Promise<ProxyResult> {
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const debug = opts.debug ?? process.env.WARDEN_PROXY_DEBUG === "1";
  const level = opts.level ?? (process.env.WARDEN_PROXY_LEVEL as CompressLevel) ?? "full";

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
  let closed = false;

  upstream.on("error", (err) => {
    spawnFailed = true;
    process.stderr.write(`warden proxy: failed to spawn upstream: ${err.message}\n`);
  });

  // --- Upstream → Client (transform responses) ---
  const responses = createLineBuffer((msg: ParsedMessage) => {
    if (!msg.parsed) {
      // Unparseable line — pass through unchanged
      writeClient(msg.raw + "\n");
      return;
    }

    messagesProcessed++;

    // Handle batch responses (arrays of JSON-RPC messages)
    if (Array.isArray(msg.json)) {
      let batchCompressed = 0;
      let batchBefore = 0;
      let batchAfter = 0;
      for (const item of msg.json) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const r = transformResponse(item as Record<string, unknown>, fields, level, debug);
          batchCompressed += r.compressed;
          batchBefore += r.bytesBefore;
          batchAfter += r.bytesAfter;
        }
      }
      descriptionsCompressed += batchCompressed;
      totalBytesBefore += batchBefore;
      totalBytesAfter += batchAfter;
      writeClient(JSON.stringify(msg.json) + "\n");
    } else if (msg.json.result !== undefined) {
      // Single response — check if it contains tool lists
      const { message: transformed, compressed, bytesBefore, bytesAfter } =
        transformResponse(msg.json as Record<string, unknown>, fields, level, debug);
      descriptionsCompressed += compressed;
      totalBytesBefore += bytesBefore;
      totalBytesAfter += bytesAfter;
      writeClient(JSON.stringify(transformed) + "\n");
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

  // --- Client → Upstream (pass through unchanged) ---
  function forwardInput(chunk: Buffer): void {
    if (closed || !upstream.stdin?.writable) return;
    if (!upstream.stdin.write(chunk)) {
      process.stdin.pause();
      const onDrain = (): void => {
        upstream.stdin?.removeListener("drain", onDrain);
        if (!closed) process.stdin.resume();
      };
      upstream.stdin.once("drain", onDrain);
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
    const onDrain = (): void => {
      process.stdout.removeListener("drain", onDrain);
      if (!closed) upstream.stdout?.resume();
    };
    process.stdout.once("drain", onDrain);
  }

  // --- Cleanup + wait for upstream to exit ---
  function cleanup(): void {
    if (closed) return;
    closed = true;
    process.stdin.pause();
    process.stdin.removeListener("data", forwardInput);
    process.stdin.removeListener("end", endInput);
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

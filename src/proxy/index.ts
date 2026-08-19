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
 *   - Optionally prunes tools/call response content behind the trust guard
 *     (opt-in) — every kept line is verbatim from the raw, never rewritten
 *   - Forwards all other messages unchanged (both directions)
 *
 * What it deliberately does NOT do:
 *   - Modify request payloads going TO the upstream server
 *   - Multi-server aggregation (single upstream only for now)
 *
 * Tool-call response pruning is the one thing description-only compressors
 * (e.g. caveman-shrink) refuse to do, because rewriting a tool's output is
 * unsafe. Warden can do it safely because the trust guard enforces that the
 * pruned output is a verbatim subsequence of the raw — lines are removed,
 * never altered. It is opt-in and defaults OFF.
 *
 * Configuration (env vars):
 *   WARDEN_PROXY_FIELDS       comma-separated field names to compress
 *                             (default: description)
 *   WARDEN_PROXY_DEBUG=1      log compression deltas to stderr
 *   WARDEN_PROXY_PRUNE_RESPONSES=1  also prune tools/call response content
 *                             (guard-verified, removal-only; default off)
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
import { PruningEngine } from "../pruner/index.js";
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
  /** tools/call response content blocks pruned (0 unless pruneResponses). */
  responseBlocksPruned: number;
  /** Bytes of tool-call response content before pruning. */
  responseBytesBefore: number;
  /** Bytes of tool-call response content after pruning. */
  responseBytesAfter: number;
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
  } = {},
): Promise<ProxyResult> {
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const debug = opts.debug ?? process.env.WARDEN_PROXY_DEBUG === "1";
  const level = opts.level ?? (process.env.WARDEN_PROXY_LEVEL as CompressLevel) ?? "full";
  const pruneResponses =
    opts.pruneResponses ?? process.env.WARDEN_PROXY_PRUNE_RESPONSES === "1";
  // Pruning engine is only built when response pruning is enabled. It needs no
  // DB or config — prune() is pure and enforces the trust guard internally.
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
  let closed = false;
  let stdinDrainListener: (() => void) | null = null;
  let stdoutDrainListener: (() => void) | null = null;

  // Track request ids whose method is "tools/call" so their responses can be
  // pruned (JSON-RPC responses carry no method name). Bounded to avoid growth
  // if the client never reads some responses.
  const pendingToolCalls = new Map<string | number, true>();
  const MAX_PENDING = 1000;
  function recordRequest(o: unknown): void {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const r = o as Record<string, unknown>;
    if (r.method !== "tools/call") return;
    if (typeof r.id !== "string" && typeof r.id !== "number") return;
    if (pendingToolCalls.size >= MAX_PENDING) {
      const oldest = pendingToolCalls.keys().next().value;
      if (oldest !== undefined) pendingToolCalls.delete(oldest);
    }
    pendingToolCalls.set(r.id, true);
  }
  // Observes the client→upstream stream to learn which ids are tools/call.
  // Observation only — it never writes; requests are still forwarded verbatim.
  const requestObserver = pruneResponses
    ? createLineBuffer((m: ParsedMessage) => {
        if (!m.parsed) return;
        if (Array.isArray(m.json)) m.json.forEach(recordRequest);
        else recordRequest(m.json);
      })
    : null;

  // Compress list descriptions and (optionally) prune a tools/call response,
  // mutating `obj` in place. Returns the byte deltas for stats.
  function handleResponseObj(obj: Record<string, unknown>): void {
    const t = transformResponse(obj, fields, level, debug);
    descriptionsCompressed += t.compressed;
    totalBytesBefore += t.bytesBefore;
    totalBytesAfter += t.bytesAfter;
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
  }

  upstream.on("error", (err) => {
    spawnFailed = true;
    process.stderr.write(`warden proxy: failed to spawn upstream: ${err.message}\n`);
    try { upstream.kill(); } catch { /* already dead */ }
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
      for (const item of msg.json) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          handleResponseObj(item as Record<string, unknown>);
        }
      }
      writeClient(JSON.stringify(msg.json) + "\n");
    } else if (msg.json.result !== undefined) {
      // Single response — compress tool-list descriptions and, if enabled and
      // this id was a tools/call, prune its response content behind the guard.
      const obj = msg.json as Record<string, unknown>;
      handleResponseObj(obj);
      writeClient(JSON.stringify(obj) + "\n");
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
    // Tee to the request observer (observation only — never mutates or blocks
    // the forwarded bytes). Wrapped so a parse hiccup can't break the stream.
    if (requestObserver) {
      try {
        requestObserver.push(chunk);
      } catch {
        /* observation only — ignore */
      }
    }
    if (!upstream.stdin.write(chunk)) {
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

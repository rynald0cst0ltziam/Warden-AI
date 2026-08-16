/**
 * Line-buffered JSON-RPC message parser for MCP stdio transport.
 *
 * MCP stdio transport uses newline-delimited JSON (NDJSON): each message is a
 * JSON object on its own line, separated by \n. This module buffers incoming
 * chunks, splits on newlines, and emits parsed JSON objects.
 *
 * Unparseable lines are passed through as-is (some servers emit non-JSON
 * lines like comments or blank lines between messages).
 */

/** A parsed JSON-RPC message or a raw string that couldn't be parsed. */
export type ParsedMessage =
  | { parsed: true; json: Record<string, unknown>; raw: string }
  | { parsed: false; raw: string };

/**
 * Create a line buffer that accumulates chunks and emits complete lines.
 * Each line is attempted to be parsed as JSON. If parsing fails, the raw
 * string is emitted with parsed: false.
 */
export function createLineBuffer(onLine: (msg: ParsedMessage) => void): {
  push: (chunk: Buffer | string) => void;
  end: () => void;
} {
  let buf = "";

  function flushLines(): void {
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length === 0) continue; // skip blank lines
      try {
        const json = JSON.parse(line);
        if (json && typeof json === "object" && !Array.isArray(json)) {
          onLine({ parsed: true, json: json as Record<string, unknown>, raw: line });
        } else {
          onLine({ parsed: false, raw: line });
        }
      } catch {
        onLine({ parsed: false, raw: line });
      }
    }
  }

  return {
    push(chunk: Buffer | string): void {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      flushLines();
    },
    end(): void {
      if (buf.trim().length > 0) {
        try {
          const json = JSON.parse(buf);
          if (json && typeof json === "object" && !Array.isArray(json)) {
            onLine({ parsed: true, json: json as Record<string, unknown>, raw: buf });
          } else {
            onLine({ parsed: false, raw: buf });
          }
        } catch {
          onLine({ parsed: false, raw: buf });
        }
      }
      buf = "";
    },
  };
}

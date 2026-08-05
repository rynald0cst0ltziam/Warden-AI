/**
 * Audit trail export — export the full decision history for compliance.
 *
 * Licensed feature. Exports all decisions (prune, promote,
 * revert, canary, observe) as JSON or CSV, suitable for compliance review.
 */
import { writeFileSync } from "node:fs";
import type { SqliteStore, DecisionRow } from "../store/sqlite.js";
import { logger } from "../logging/index.js";

export type ExportFormat = "json" | "csv";

/**
 * Encode a value as a safe CSV cell.
 * - Neutralizes formula/CSV injection: a leading =, +, -, @, tab or CR can be
 *   interpreted as a formula by spreadsheet apps (Excel/Sheets). We prefix such
 *   values with a single quote so they render as literal text.
 * - Always quotes and doubles embedded quotes so commas/newlines are safe.
 */
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Parse a stored JSON column, returning the raw string if it isn't valid JSON. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

export interface ExportOptions {
  format: ExportFormat;
  /** Filter by rule id (optional). */
  ruleId?: string;
  /** Filter by kind (optional: "prune", "promote", "revert", etc). */
  kind?: string;
  /** Limit number of records (default: all). */
  limit?: number;
  /** Output file path. If omitted, returns the string. */
  outputPath?: string;
}

export interface ExportResult {
  format: ExportFormat;
  recordCount: number;
  /** The exported content (if not written to file). */
  content?: string;
  /** The file path (if written to file). */
  filePath?: string;
}

/** Export the audit trail. */
export function exportAuditTrail(
  store: SqliteStore,
  opts: ExportOptions,
): ExportResult {
  let decisions: DecisionRow[] = store.recentDecisions(opts.limit ?? 100000);
  if (opts.ruleId) {
    decisions = decisions.filter((d) => d.rule_id === opts.ruleId);
  }
  if (opts.kind) {
    decisions = decisions.filter((d) => d.kind === opts.kind);
  }

  let content: string;
  if (opts.format === "json") {
    content = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        recordCount: decisions.length,
        decisions: decisions.map((d) => ({
          id: d.id,
          timestamp: d.timestamp,
          kind: d.kind,
          ruleId: d.rule_id,
          toolType: d.tool_type,
          tokensSaved: d.tokens_saved,
          detail: safeParse(d.detail_json),
        })),
      },
      null,
      2,
    );
  } else {
    // CSV
    const headers = [
      "id",
      "timestamp",
      "kind",
      "rule_id",
      "tool_type",
      "tokens_saved",
      "detail",
    ];
    const rows = decisions.map((d) =>
      [
        csvCell(d.id),
        csvCell(d.timestamp),
        csvCell(d.kind),
        csvCell(d.rule_id ?? ""),
        csvCell(d.tool_type ?? ""),
        csvCell(d.tokens_saved),
        csvCell(d.detail_json),
      ].join(","),
    );
    content = [headers.join(","), ...rows].join("\n");
  }

  if (opts.outputPath) {
    writeFileSync(opts.outputPath, content, "utf8");
    logger.info("audit trail exported", {
      format: opts.format,
      records: decisions.length,
      path: opts.outputPath,
    });
    return {
      format: opts.format,
      recordCount: decisions.length,
      filePath: opts.outputPath,
    };
  }

  return { format: opts.format, recordCount: decisions.length, content };
}

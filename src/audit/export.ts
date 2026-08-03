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
          detail: JSON.parse(d.detail_json),
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
        d.id,
        d.timestamp,
        d.kind,
        d.rule_id ?? "",
        d.tool_type ?? "",
        d.tokens_saved,
        '"' + d.detail_json.replace(/"/g, '""') + '"',
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

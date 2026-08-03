/**
 * Minimal structured logger. Writes to stderr so it never pollutes the MCP
 * stdio JSON-RPC channel (which lives on stdout). Respects a WARDEN_DEBUG
 * env flag for verbose output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): number {
  const env = (process.env.WARDEN_DEBUG ?? "").toLowerCase();
  if (env === "1" || env === "true" || env === "debug") return LEVELS.debug;
  return LEVELS.info;
}

function ts(): string {
  return new Date().toISOString();
}

export function log(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = fields
    ? `${ts()} [${level}] ${msg} ${JSON.stringify(fields)}`
    : `${ts()} [${level}] ${msg}`;
  // eslint-disable-next-line no-console
  console.error(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    log("error", msg, fields),
};

/**
 * Indirection for `node:sqlite` so the bundler doesn't rewrite the `node:`
 * prefix to a bare specifier (which then fails to resolve at runtime).
 *
 * esbuild/tsup strip `node:` -> bare for built-ins; importing through a
 * dynamic `import()` preserves the exact specifier string.
 */
import type { DatabaseSync as DB } from "node:sqlite";

export type DatabaseSync = DB;

let cached: typeof import("node:sqlite") | null = null;

export async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  if (cached) return cached;
  // Build the specifier at runtime so the bundler can't rewrite `node:` -> bare.
  const spec = "node" + ":sqlite";
  cached = (await import(spec)) as typeof import("node:sqlite");
  return cached;
}

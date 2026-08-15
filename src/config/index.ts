import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let _version = "0.0.0";
try {
  // In bundled output (dist/cli.js), import.meta.url points to dist/
  // package.json is one level up from dist/
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  _version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
} catch {
  // Fallback for environments where package.json isn't accessible
}
export const PKG_VERSION = _version;

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the Warden data dir for a given repo (or the global one). */
export function wardenDir(repoRoot?: string): string {
  if (repoRoot) return join(repoRoot, ".warden");
  // Global fallback: ~/.warden
  return join(homedir(), ".warden");
}

export function ensureWardenDir(repoRoot?: string): string {
  const dir = wardenDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(repoRoot?: string): string {
  return join(ensureWardenDir(repoRoot), "warden.db");
}

/** Initial stage for newly registered built-in pruning rules. */
export type DefaultRuleStage = "shadow" | "active";

export interface WardenConfig {
  /** Stage new built-in rules start in. "active" = prune live from first run. */
  defaultRuleStage: DefaultRuleStage;
  /** Auto-promote a shadow rule once confidence >= this (0..1). null = manual only. */
  autoPromoteConfidence: number | null;
  /** Minimum shadow runs before a rule is eligible for promotion. */
  minShadowRuns: number;
  /** Rolling window (N) for confidence scoring. */
  confidenceWindow: number;
  /** Days after which an un-revalidated rule's confidence begins to decay. */
  confidenceDecayDays: number;
  /** Max lines of a file read before slice + outline pruning kicks in. */
  fileReadLargeThresholdLines: number;
  /** Max grep matches to keep verbatim before collapsing the rest. */
  grepMaxMatches: number;
  /** Lines of context to keep around a test/log failure. */
  testLogFailureContextLines: number;
  /** Shell output: max lines to keep for tail-heavy outputs (docker logs, kubectl logs). */
  shellTailLines: number;
  /** Shell output: max commits to keep for git log before collapsing. */
  shellGitLogMaxCommits: number;
  /** Shell output: max results for find/tree before collapsing. */
  shellFindMaxResults: number;
  /** Shell output: max processes for ps aux before collapsing. */
  shellPsMaxProcesses: number;
  /** Risk tolerance preset. */
  riskTolerance: "startup" | "balanced" | "enterprise";
}

export const DEFAULT_CONFIG: WardenConfig = {
  defaultRuleStage: "active",
  autoPromoteConfidence: null, // manual promotion for custom rules; built-ins start active
  minShadowRuns: 10,
  confidenceWindow: 50,
  confidenceDecayDays: 14,
  fileReadLargeThresholdLines: 400,
  grepMaxMatches: 40,
  testLogFailureContextLines: 8,
  shellTailLines: 50,
  shellGitLogMaxCommits: 15,
  shellFindMaxResults: 30,
  shellPsMaxProcesses: 15,
  riskTolerance: "balanced",
};

export function configForRisk(
  risk: WardenConfig["riskTolerance"],
): WardenConfig {
  switch (risk) {
    case "startup":
      return {
        ...DEFAULT_CONFIG,
        riskTolerance: "startup",
        defaultRuleStage: "active",
        autoPromoteConfidence: 0.9,
        minShadowRuns: 20,
      };
    case "enterprise":
      return {
        ...DEFAULT_CONFIG,
        riskTolerance: "enterprise",
        defaultRuleStage: "shadow",
        autoPromoteConfidence: null, // always manual
        minShadowRuns: 50,
        confidenceWindow: 100,
      };
    case "balanced":
    default:
      return { ...DEFAULT_CONFIG, riskTolerance: "balanced" };
  }
}

/**
 * Resolve the repo root by walking up from cwd looking for .git.
 * If no .git is found, use the start directory itself as the project root.
 * This ensures each project gets its own .warden/warden.db instead of
 * everything falling back to the global ~/.warden/warden.db.
 *
 * Only returns undefined if start is undefined or empty.
 */
export function findRepoRoot(
  start: string = process.cwd(),
): string | undefined {
  if (!start) return undefined;
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    // Also check for common project markers
    if (existsSync(join(dir, "package.json")) ||
        existsSync(join(dir, "Cargo.toml")) ||
        existsSync(join(dir, "go.mod")) ||
        existsSync(join(dir, "pyproject.toml")) ||
        existsSync(join(dir, "pom.xml")) ||
        existsSync(join(dir, "build.gradle"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // No .git or project marker found — use the start directory as the project root
      // rather than falling back to global ~/.warden
      return resolve(start);
    }
    dir = parent;
  }
}

export { here };

/**
 * Git context — P3 tool for extracting history and churn metrics.
 *
 * Provides file history, blame, and change frequency data so the agent
 * can understand why code looks the way it does, without reading full
 * git log output (which is extremely verbose).
 *
 * All git commands are executed via child_process.execFileSync with
 * bounded output. No shell interpolation — arguments passed as array.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBlameLine {
  sha: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

export interface GitFileHistory {
  filePath: string;
  commits: GitCommit[];
  totalCommits: number;
  lastCommit: string | null;
  authors: string[];
}

export interface GitChangeFrequency {
  filePath: string;
  totalCommits: number;
  linesAdded: number;
  linesDeleted: number;
  churnScore: number;
  lastCommit: string | null;
}

export interface GitContextResult {
  filePath: string;
  history?: GitFileHistory;
  blame?: GitBlameLine[];
  changeFrequency?: GitChangeFrequency;
}

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(repoRoot: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repoRoot, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Get file history — recent commits that touched a file.
 *
 * @param repoRoot - Repository root directory.
 * @param filePath - Path to the file (relative to repoRoot, or absolute).
 * @param limit - Max commits to return (default 10).
 */
export function gitFileHistory(
  repoRoot: string,
  filePath: string,
  limit = 10,
): GitFileHistory {
  const absPath = resolve(repoRoot, filePath);
  const relPath = absPath.startsWith(repoRoot)
    ? absPath.slice(repoRoot.length + 1).replace(/\\/g, "/")
    : filePath;

  const format = "%H%x00%an%x00%ad%x00%s";
  const out = execFileSync(
    "git",
    ["log", "--follow", `--pretty=format:${format}`, `--max-count=${limit}`, "--", relPath],
    { cwd: repoRoot, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
  );

  const commits: GitCommit[] = out
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\x00");
      return {
        sha: parts[0] ?? "",
        author: parts[1] ?? "",
        date: parts[2] ?? "",
        message: parts[3] ?? "",
      };
    });

  const authors = Array.from(new Set(commits.map((c) => c.author)));

  return {
    filePath: relPath,
    commits,
    totalCommits: commits.length,
    lastCommit: commits.length > 0 ? (commits[0]?.date ?? null) : null,
    authors,
  };
}

/**
 * Get blame for a line range of a file.
 *
 * @param repoRoot - Repository root directory.
 * @param filePath - Path to the file.
 * @param startLine - Start line (1-based, inclusive).
 * @param endLine - End line (1-based, inclusive).
 */
export function gitBlame(
  repoRoot: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): GitBlameLine[] {
  const absPath = resolve(repoRoot, filePath);
  const relPath = absPath.startsWith(repoRoot)
    ? absPath.slice(repoRoot.length + 1).replace(/\\/g, "/")
    : filePath;

  const args = ["blame", "--line-porcelain"];
  if (startLine && endLine) {
    args.push(`-L`, `${startLine},${endLine}`);
  }
  args.push("--", relPath);

  const out = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = out.split("\n");
  const result: GitBlameLine[] = [];
  let currentSha = "";
  let currentAuthor = "";
  let currentDate = "";
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("\t")) {
      // Content line — preceded by metadata
      result.push({
        sha: currentSha,
        author: currentAuthor,
        date: currentDate,
        line: currentLine,
        content: line.slice(1),
      });
    } else if (line.startsWith("author ")) {
      currentAuthor = line.slice(7);
    } else if (line.startsWith("author-mail ")) {
      // Skip — already have author name
    } else if (line.startsWith("author-time ")) {
      const ts = parseInt(line.slice(12), 10);
      currentDate = new Date(ts * 1000).toISOString();
    } else if (line.startsWith("committer-time ")) {
      // Use author-time as primary; fall back to committer-time
      if (!currentDate) {
        const ts = parseInt(line.slice(14), 10);
        currentDate = new Date(ts * 1000).toISOString();
      }
    } else if (/^[0-9a-f]{40}/.test(line)) {
      // SHA line — starts a new blame entry
      const parts = line.split(" ");
      currentSha = parts[0] ?? "";
      currentLine = parseInt(parts[parts.length - 1] ?? "0", 10);
    }
  }

  return result;
}

/**
 * Get change frequency metrics for a file — how often it changes,
 * lines added/deleted, churn score.
 *
 * @param repoRoot - Repository root directory.
 * @param filePath - Path to the file.
 */
export function gitChangeFrequency(
  repoRoot: string,
  filePath: string,
): GitChangeFrequency {
  const absPath = resolve(repoRoot, filePath);
  const relPath = absPath.startsWith(repoRoot)
    ? absPath.slice(repoRoot.length + 1).replace(/\\/g, "/")
    : filePath;

  // Get total commit count for this file
  const countOut = execFileSync(
    "git",
    ["rev-list", "--count", "HEAD", "--", relPath],
    { cwd: repoRoot, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
  );
  const totalCommits = parseInt(countOut.trim(), 10) || 0;

  // Get lines added/deleted
  const numstatOut = execFileSync(
    "git",
    ["log", "--numstat", "--pretty=format:", "--", relPath],
    { cwd: repoRoot, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
  );

  let linesAdded = 0;
  let linesDeleted = 0;
  for (const line of numstatOut.trim().split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const added = parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10);
      const deleted = parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10);
      if (!isNaN(added)) linesAdded += added;
      if (!isNaN(deleted)) linesDeleted += deleted;
    }
  }

  // Churn score = total lines changed / total commits
  const churnScore = totalCommits > 0
    ? Math.round(((linesAdded + linesDeleted) / totalCommits) * 10) / 10
    : 0;

  // Get last commit date
  let lastCommit: string | null = null;
  try {
    const dateOut = execFileSync(
      "git",
      ["log", "-1", "--pretty=format:%ad", "--", relPath],
      { cwd: repoRoot, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    lastCommit = dateOut.trim() || null;
  } catch {
    // File might not be tracked yet
  }

  return {
    filePath: relPath,
    totalCommits,
    linesAdded,
    linesDeleted,
    churnScore,
    lastCommit,
  };
}

/**
 * Get full git context for a file — history, blame (optional), and
 * change frequency. This is the main entry point for the MCP tool.
 *
 * @param repoRoot - Repository root directory.
 * @param filePath - Path to the file.
 * @param startLine - Optional start line for blame.
 * @param endLine - Optional end line for blame.
 * @param includeBlame - Whether to include blame data (default false — blame is slow).
 */
export function gitContext(
  repoRoot: string,
  filePath: string,
  options?: {
    startLine?: number;
    endLine?: number;
    includeBlame?: boolean;
  },
): GitContextResult {
  if (!isGitRepo(repoRoot)) {
    return { filePath };
  }

  // Check if file exists on disk — skip git operations for non-existent files
  // (git log --follow on a non-existent path walks the entire history slowly)
  const absPath = resolve(repoRoot, filePath);
  if (!existsSync(absPath)) {
    return { filePath };
  }

  const result: GitContextResult = { filePath };

  try {
    result.history = gitFileHistory(repoRoot, filePath, 10);
  } catch {
    // File might not be tracked
  }

  if (options?.includeBlame || (options?.startLine && options?.endLine)) {
    try {
      result.blame = gitBlame(
        repoRoot,
        filePath,
        options?.startLine,
        options?.endLine,
      );
    } catch {
      // Blame might fail for new files
    }
  }

  try {
    result.changeFrequency = gitChangeFrequency(repoRoot, filePath);
  } catch {
    // File might not be tracked
  }

  return result;
}

/**
 * Format git context as human-readable text for MCP/CLI output.
 */
export function formatGitContext(ctx: GitContextResult): string {
  const lines: string[] = [
    `GIT CONTEXT — ${ctx.filePath}`,
    "",
  ];

  if (ctx.history && ctx.history.totalCommits > 0) {
    lines.push(`HISTORY (${ctx.history.totalCommits} recent commits)`);
    for (const c of ctx.history.commits) {
      const msg = c.message.length > 72 ? c.message.slice(0, 72) + "..." : c.message;
      lines.push(`  ${c.sha.slice(0, 8)} ${c.date} ${c.author}: ${msg}`);
    }
    lines.push("");
  } else {
    lines.push("HISTORY: no commits found (file may be untracked)");
    lines.push("");
  }

  if (ctx.changeFrequency) {
    const cf = ctx.changeFrequency;
    lines.push("CHANGE FREQUENCY");
    lines.push(`  Total commits: ${cf.totalCommits}`);
    lines.push(`  Lines added: ${cf.linesAdded}`);
    lines.push(`  Lines deleted: ${cf.linesDeleted}`);
    lines.push(`  Churn score: ${cf.churnScore} lines/commit`);
    lines.push(`  Last commit: ${cf.lastCommit ?? "never"}`);
    lines.push("");
  }

  if (ctx.blame && ctx.blame.length > 0) {
    lines.push(`BLAME (${ctx.blame.length} lines)`);
    for (const b of ctx.blame) {
      const content = b.content.length > 80 ? b.content.slice(0, 80) + "..." : b.content;
      lines.push(`  L${b.line} ${b.sha.slice(0, 8)} ${b.author}: ${content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

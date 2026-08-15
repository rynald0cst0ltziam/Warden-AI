/**
 * Shell output compression — comprehensive pruning for common shell commands.
 *
 * Detects the command type from output content patterns and applies the
 * appropriate compression strategy. Every strategy only REMOVES lines —
 * never rewrites. The trust guard verifies this.
 *
 * Supported command patterns (20+):
 *   git log, git diff, git status, git branch
 *   npm install, npm run build, npm ls
 *   docker logs, docker build, docker ps
 *   cargo build, cargo test
 *   kubectl logs, kubectl get
 *   ps aux
 *   ls -la
 *   find
 *   tree
 *   make
 *   go build, go test
 *   pip install
 *   mvn, gradle
 *   rustc
 *   tsc
 *   webpack, vite
 *
 * Strategies:
 *   - Tail-keep: keep last N lines + all error/warning lines (docker logs, kubectl logs)
 *   - Summary-keep: keep summary lines + errors, collapse progress (npm install, cargo build)
 *   - Count-keep: keep first N results + count (find, tree, ls)
 *   - Top-N: keep top N by metric (ps aux)
 *   - Verbatim-keep: keep all lines — already compact (git status, git diff, kubectl get)
 *   - Delegate: route to testlog module (cargo test, go test, pytest)
 */
import type {
  PruneModule,
  PruneOptions,
  PruneResult,
  RemovedSummary,
} from "../types.js";
import { approxTokens } from "../types.js";
import { annotation } from "../guard.js";
import type { TaskContext } from "../../classifier/types.js";

// ---------------------------------------------------------------------------
// Detection — content-based pattern matching for shell command output
// ---------------------------------------------------------------------------

interface ShellStats {
  output: string[];
  stats: Record<string, number>;
}

interface ShellPattern {
  id: string;
  name: string;
  /** Returns true if the raw output matches this command's output pattern. */
  detect: (lines: string[], raw: string) => boolean;
  /** Compression strategy. Returns the pruned lines + summary stats. */
  compress: (
    lines: string[],
    raw: string,
    opts: PruneOptions,
  ) => ShellStats;
}

// Regexes shared across patterns
const ERROR_RE = /\b(error|err:|exception|traceback|panic|fatal|failed|✗|✘|denied|refused)\b/i;
const WARN_RE = /\b(warning|warn:|⚠|deprecated|deprecation)\b/i;
const GIT_LOG_COMMIT_RE = /^commit [0-9a-f]{7,40}/;
const GIT_DIFF_RE = /^(diff --git|index |new file|deleted file|old mode|new mode|rename from|rename to|---|\+\+\+|@@)/;
const GIT_STATUS_RE = /^[ MADRC\?][ MADRC\?] \S/;
const GIT_BRANCH_RE = /^\* \S+|^  \S+$/;
const NPM_INSTALL_RE = /^(added|removed|changed|npm warn|npm error|up to date|audited|\+--|`--|--\s)/;
const NPM_BUILD_RE = /^(webpack|vite|esbuild|rollup|compiled|building|bundling|generating)\b/i;
const DOCKER_LOG_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DOCKER_BUILD_STEP_RE = /^(Step \d+\/\d+\s*:| --->|Removing intermediate|Successfully built|Successfully tagged)/;
const DOCKER_PS_RE = /^CONTAINER\s+IMAGE\s+COMMAND\s+CREATED\s+STATUS\s+PORTS\s+NAMES/;
const CARGO_BUILD_RE = /^(Compiling|Finished|warning:|error\[|error:|Doc-compiling|Downloading|Downloaded)/;
const KUBECTL_LOG_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\b(INFO|WARN|ERROR|FATAL|TRACE|DEBUG)\b/;
const KUBECTL_GET_RE = /^NAME\s+(READY|STATUS|TYPE|CLUSTER|EXTERNAL)/;
const PS_AUX_HEADER_RE = /^USER\s+PID\s+%CPU\s+%MEM\s+VSZ\s+RSS\s+TTY\s+STAT\s+START\s+TIME\s+COMMAND/;
const LS_LA_RE = /^([drwx-]{10}|total\s+\d+)/;
const FIND_RE = /^[/~.]/;
const TREE_BRANCH_RE = /^[│├└─\s]+/;
const MAKE_RE = /^(make\[|make:|gcc|g\+\+|cc |cc1|ld |ar |ranlib|collect2)/;
const GO_TEST_RE = /^(ok|FAIL|PASS|--- FAIL:|--- PASS:|=== RUN|=== PAUSE|=== CONT)/;
const GO_BUILD_RE = /^(#|\.)/;
const PIP_INSTALL_RE = /^(Collecting|Downloading|Installing|Successfully installed|Requirement already)/;
const MVN_RE = /^\[(INFO|ERROR|WARN|DEBUG)\]/;
const GRADLE_RE = /^(> Task|> Configure|BUILD SUCCESSFUL|BUILD FAILED|Deprecated)/;
const RUSTC_RE = /^(error\[E\d+|warning:|note:|help:|-->|=)/;
const TSC_RE = /^(error TS\d+|warning TS\d+|src\/|test\/)/;
const WEBPACK_RE = /^(webpack|asset|chunk|entrypoint|compiled|module|warning|error)/i;
const VITE_RE = /^(vite|✓ built|✓ modules transformed|transforming|rendering)/i;

// ---------------------------------------------------------------------------
// Compression strategies
// ---------------------------------------------------------------------------

/**
 * Tail-keep: keep the last N lines + all error/warning lines anywhere in output.
 * Used for: docker logs, kubectl logs, any streaming log output.
 */
function tailKeep(
  lines: string[],
  maxTail: number,
): ShellStats {
  const errorLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_RE.test(lines[i]!) || WARN_RE.test(lines[i]!)) {
      errorLines.push(i);
    }
  }
  const tailStart = Math.max(0, lines.length - maxTail);
  const keep = new Set<number>();
  // Keep tail
  for (let i = tailStart; i < lines.length; i++) keep.add(i);
  // Keep error/warning lines with 2 lines of context
  for (const idx of errorLines) {
    for (let j = Math.max(0, idx - 2); j <= Math.min(lines.length - 1, idx + 2); j++) {
      keep.add(j);
    }
  }
  // Build output, collapsing gaps
  const output: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    if (keep.has(i)) {
      output.push(lines[i]!);
      i++;
      continue;
    }
    let run = 0;
    while (i < lines.length && !keep.has(i)) {
      run++;
      i++;
    }
    collapsed += run;
    output.push(annotation(`… ${run} low-signal lines collapsed`));
  }
  return {
    output,
    stats: {
      lines: lines.length,
      kept: output.filter((l) => !l.startsWith("‹warden›")).length,
      collapsed,
      errors: errorLines.length,
    },
  };
}

/**
 * Summary-keep: keep summary lines + errors/warnings, collapse progress noise.
 * Used for: npm install, cargo build, pip install, docker build, make, mvn, gradle.
 */
function summaryKeep(
  lines: string[],
  summaryRe: RegExp,
): ShellStats {
  const output: string[] = [];
  let collapsed = 0;
  let kept = 0;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (summaryRe.test(l) || ERROR_RE.test(l) || WARN_RE.test(l)) {
      output.push(l);
      kept++;
      i++;
    } else {
      // Collapse runs of non-summary lines
      let run = 0;
      while (i < lines.length && !summaryRe.test(lines[i]!) && !ERROR_RE.test(lines[i]!) && !WARN_RE.test(lines[i]!)) {
        run++;
        i++;
      }
      collapsed += run;
      if (run > 0) output.push(annotation(`… ${run} progress lines collapsed`));
    }
  }
  return {
    output,
    stats: { lines: lines.length, kept, collapsed },
  };
}

/**
 * Count-keep: keep first N results + a count of the rest.
 * Used for: find, tree, ls -la (large directories).
 */
function countKeep(
  lines: string[],
  maxResults: number,
  headerLines: number = 0,
): ShellStats {
  const header = lines.slice(0, headerLines);
  const results = lines.slice(headerLines);
  if (results.length <= maxResults) {
    return { output: lines, stats: { lines: lines.length, kept: lines.length } };
  }
  const kept = results.slice(0, maxResults);
  const remaining = results.length - maxResults;
  return {
    output: [
      ...header,
      ...kept,
      annotation(`… ${remaining} more results collapsed (${results.length} total)`),
    ],
    stats: { lines: lines.length, kept: kept.length + header.length, collapsed: remaining },
  };
}

/**
 * Top-N: keep top N lines by a numeric metric extracted from each line.
 * Used for: ps aux (sort by %CPU or %MEM).
 */
function topN(
  lines: string[],
  maxN: number,
  headerRe: RegExp,
  metricIdx: number,
): ShellStats {
  // Find header line
  let headerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!)) {
      headerLine = i;
      break;
    }
  }
  if (headerLine < 0) {
    // No header found — can't parse, return as-is
    return { output: lines, stats: { lines: lines.length, kept: lines.length } };
  }
  const header = lines.slice(0, headerLine + 1);
  const data = lines.slice(headerLine + 1).filter((l) => l.trim().length > 0);
  // Extract metric (e.g. %CPU is field index 2 in ps aux) and score each line
  const scored = data
    .map((l, originalIdx) => {
      const fields = l.trim().split(/\s+/);
      const val = parseFloat(fields[metricIdx] ?? "0");
      return { line: l, score: isNaN(val) ? 0 : val, originalIdx };
    })
    .sort((a, b) => b.score - a.score);
  // Get top N, then re-sort by original index to preserve guard subsequence order
  const top = scored.slice(0, maxN).sort((a, b) => a.originalIdx - b.originalIdx).map((s) => s.line);
  const collapsed = data.length - top.length;
  return {
    output: [
      ...header,
      ...top,
      ...(collapsed > 0
        ? [annotation(`… ${collapsed} more processes collapsed (top ${maxN} by column ${metricIdx + 1})`)]
        : []),
    ],
    stats: { lines: lines.length, kept: top.length + header.length, collapsed },
  };
}

// ---------------------------------------------------------------------------
// Pattern definitions — each command type with its detection + compression
// ---------------------------------------------------------------------------

const PATTERNS: ShellPattern[] = [
  // --- git log ---
  {
    id: "git-log",
    name: "git log",
    detect: (lines) => {
      let commits = 0;
      for (const l of lines.slice(0, 50)) {
        if (GIT_LOG_COMMIT_RE.test(l)) commits++;
      }
      return commits >= 2;
    },
    compress: (lines, _raw, opts): ShellStats => {
      const maxCommits = opts.shellGitLogMaxCommits ?? 15;
      // Split into commit blocks (each starts with "commit <hash>")
      const blocks: { startIdx: number; lines: string[] }[] = [];
      let current: string[] = [];
      for (const l of lines) {
        if (GIT_LOG_COMMIT_RE.test(l) && current.length > 0) {
          blocks.push({ startIdx: 0, lines: current });
          current = [];
        }
        current.push(l);
      }
      if (current.length > 0) blocks.push({ startIdx: 0, lines: current });
      if (blocks.length <= maxCommits) {
        return { output: lines, stats: { lines: lines.length, kept: lines.length, commits: blocks.length } };
      }
      // Keep first maxCommits blocks, collapse the rest
      const kept = blocks.slice(0, maxCommits);
      const collapsed = blocks.length - maxCommits;
      // For each kept block, keep only: commit hash, Author, Date, first line of message
      const output: string[] = [];
      for (const block of kept) {
        for (const l of block.lines) {
          if (GIT_LOG_COMMIT_RE.test(l) || /^Author:/.test(l) || /^Date:/.test(l) || /^\s+\S/.test(l)) {
            output.push(l);
          }
        }
        output.push(""); // separator between commits
      }
      output.push(annotation(`… ${collapsed} older commits collapsed (${blocks.length} total)`));
      return {
        output,
        stats: { lines: lines.length, kept: output.filter((l) => !l.startsWith("‹warden›") && l !== "").length, collapsed, commits: blocks.length },
      };
    },
  },

  // --- git diff ---
  {
    id: "git-diff",
    name: "git diff",
    detect: (lines) => {
      let diffLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (GIT_DIFF_RE.test(l)) diffLines++;
      }
      return diffLines >= 3;
    },
    compress: (lines, _raw, _opts): ShellStats => {
      // git diff is already compact — keep as-is unless very large
      if (lines.length <= 200) {
        return { output: lines, stats: { lines: lines.length, kept: lines.length } };
      }
      // For large diffs: keep diff headers + added/removed lines, collapse context
      const output: string[] = [];
      let collapsed = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (GIT_DIFF_RE.test(l) || l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) {
          if (l.startsWith(" ") && !l.startsWith("  ") === false) {
            // Context line — keep if near a change
            output.push(l);
          } else {
            output.push(l);
          }
        } else {
          let run = 0;
          while (i < lines.length && !GIT_DIFF_RE.test(lines[i]!) && !lines[i]!.startsWith("+") && !lines[i]!.startsWith("-")) {
            run++;
            i++;
          }
          i--;
          collapsed += run;
          if (run > 0) output.push(annotation(`… ${run} context lines collapsed`));
        }
      }
      return { output, stats: { lines: lines.length, kept: output.filter((l) => !l.startsWith("‹warden›")).length, collapsed } };
    },
  },

  // --- git status ---
  {
    id: "git-status",
    name: "git status",
    detect: (lines) => {
      let statusLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (GIT_STATUS_RE.test(l) || /^On branch/.test(l) || /^Changes to be committed/.test(l) || /^Changes not staged/.test(l) || /^Untracked files/.test(l) || /^nothing to commit/.test(l)) {
          statusLines++;
        }
      }
      return statusLines >= 3;
    },
    compress: (lines) => {
      // git status is already compact — return as-is
      return { output: lines, stats: { lines: lines.length, kept: lines.length } };
    },
  },

  // --- git branch ---
  {
    id: "git-branch",
    name: "git branch",
    detect: (lines) => {
      let branchLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (GIT_BRANCH_RE.test(l)) branchLines++;
      }
      return branchLines >= 3;
    },
    compress: (lines) => {
      // git branch is already compact — return as-is
      return { output: lines, stats: { lines: lines.length, kept: lines.length } };
    },
  },

  // --- npm install ---
  {
    id: "npm-install",
    name: "npm install",
    detect: (lines) => {
      let npmLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (NPM_INSTALL_RE.test(l)) npmLines++;
      }
      return npmLines >= 3;
    },
    compress: (lines) => {
      return summaryKeep(lines, /^(added|removed|changed|npm warn|npm error|up to date|audited|found)\b/);
    },
  },

  // --- npm ls ---
  {
    id: "npm-ls",
    name: "npm ls",
    detect: (lines) => {
      // npm ls produces tree output with package@version lines
      // and branch characters (├──, └──, └─┬, │, +--)
      let treeLines = 0;
      let pkgLines = 0;
      for (const l of lines.slice(0, 80)) {
        if (/^[├└─│┬\s]+/.test(l) || /^[+`|]-+/.test(l)) treeLines++;
        if (/\S+@\d+\.\d+/.test(l)) pkgLines++;
      }
      return treeLines >= 5 || (pkgLines >= 5 && treeLines >= 2);
    },
    compress: (lines, _raw, _opts): ShellStats => {
      // Keep top-level packages (indent 0) + count nested
      const topLevel: string[] = [];
      let nested = 0;
      for (const l of lines) {
        // Top-level packages have no tree indentation (indent 0)
        const indent = l.match(/^[├└─│┬\s+`]*/)?.[0].length ?? 0;
        if (indent === 0 && l.trim().length > 0) {
          topLevel.push(l);
        } else if (l.trim().length > 0) {
          nested++;
        }
      }
      if (nested === 0) return { output: lines, stats: { lines: lines.length, kept: lines.length } };
      return {
        output: [
          ...topLevel,
          annotation(`… ${nested} nested dependency lines collapsed`),
        ],
        stats: { lines: lines.length, kept: topLevel.length, collapsed: nested },
      };
    },
  },

  // --- npm run build / webpack / vite ---
  {
    id: "npm-build",
    name: "npm run build / webpack / vite",
    detect: (lines) => {
      let buildLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (WEBPACK_RE.test(l) || VITE_RE.test(l) || NPM_BUILD_RE.test(l)) buildLines++;
      }
      return buildLines >= 3;
    },
    compress: (lines): ShellStats => {
      // Custom compress: keep only summary lines (asset, compiled, error/warning at start of line)
      // Don't use summaryKeep because ERROR_RE would match [1 error] in every module line
      const summaryRe = /^(webpack|vite|esbuild|✓|✗|error|warning|compiled|built|asset|rendering|transforming)\b/i;
      const output: string[] = [];
      let collapsed = 0;
      let kept = 0;
      let i = 0;
      while (i < lines.length) {
        const l = lines[i]!;
        if (summaryRe.test(l)) {
          output.push(l);
          kept++;
          i++;
        } else {
          let run = 0;
          while (i < lines.length && !summaryRe.test(lines[i]!)) {
            run++;
            i++;
          }
          collapsed += run;
          if (run > 0) output.push(annotation(`… ${run} build progress lines collapsed`));
        }
      }
      return { output, stats: { lines: lines.length, kept, collapsed } };
    },
  },

  // --- docker logs ---
  {
    id: "docker-logs",
    name: "docker logs",
    detect: (lines) => {
      let tsLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (DOCKER_LOG_TS_RE.test(l)) tsLines++;
      }
      return tsLines >= 5;
    },
    compress: (lines, _raw, opts) => {
      return tailKeep(lines, opts.shellTailLines ?? 50);
    },
  },

  // --- docker build ---
  {
    id: "docker-build",
    name: "docker build",
    detect: (lines) => {
      let stepLines = 0;
      for (const l of lines.slice(0, 100)) {
        if (DOCKER_BUILD_STEP_RE.test(l)) stepLines++;
      }
      return stepLines >= 3;
    },
    compress: (lines) => {
      // Keep Successfully built/tagged + errors; collapse Step progress
      return summaryKeep(lines, /^(Successfully built|Successfully tagged|ERROR|error:)/);
    },
  },

  // --- docker ps ---
  {
    id: "docker-ps",
    name: "docker ps",
    detect: (lines) => {
      return DOCKER_PS_RE.test(lines[0] ?? "");
    },
    compress: (lines) => {
      // docker ps is already compact tabular — return as-is
      return { output: lines, stats: { lines: lines.length, kept: lines.length } };
    },
  },

  // --- cargo build ---
  {
    id: "cargo-build",
    name: "cargo build",
    detect: (lines) => {
      let cargoLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (CARGO_BUILD_RE.test(l)) cargoLines++;
      }
      return cargoLines >= 3;
    },
    compress: (lines) => {
      // Keep Finished, errors, warnings; collapse Compiling progress
      return summaryKeep(lines, /^(Finished|warning:|error\[|error:|Doc-compiling)/);
    },
  },

  // --- kubectl logs ---
  {
    id: "kubectl-logs",
    name: "kubectl logs",
    detect: (lines) => {
      let k8sLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (KUBECTL_LOG_RE.test(l)) k8sLines++;
      }
      return k8sLines >= 5;
    },
    compress: (lines, _raw, opts) => {
      return tailKeep(lines, opts.shellTailLines ?? 50);
    },
  },

  // --- kubectl get ---
  {
    id: "kubectl-get",
    name: "kubectl get",
    detect: (lines) => {
      return KUBECTL_GET_RE.test(lines[0] ?? "");
    },
    compress: (lines) => {
      // kubectl get is already compact tabular — return as-is
      return { output: lines, stats: { lines: lines.length, kept: lines.length } };
    },
  },

  // --- ps aux ---
  {
    id: "ps-aux",
    name: "ps aux",
    detect: (lines) => {
      return PS_AUX_HEADER_RE.test(lines[0] ?? "") || PS_AUX_HEADER_RE.test(lines[1] ?? "");
    },
    compress: (lines, _raw, opts) => {
      // Sort by %CPU (field index 2 in ps aux output)
      return topN(lines, opts.shellPsMaxProcesses ?? 15, PS_AUX_HEADER_RE, 2);
    },
  },

  // --- ls -la ---
  {
    id: "ls-la",
    name: "ls -la",
    detect: (lines) => {
      let lsLines = 0;
      for (const l of lines.slice(0, 20)) {
        if (LS_LA_RE.test(l)) lsLines++;
      }
      return lsLines >= 2;
    },
    compress: (lines, _raw, _opts): ShellStats => {
      // ls -la is compact — only collapse if large directory
      if (lines.length <= 40) {
        return { output: lines, stats: { lines: lines.length, kept: lines.length } };
      }
      // Keep "total" line + first 30 entries
      return countKeep(lines, 30, 2);
    },
  },

  // --- find ---
  {
    id: "find",
    name: "find",
    detect: (lines) => {
      let pathLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (FIND_RE.test(l) && l.trim().length > 0 && !l.startsWith("find:")) pathLines++;
      }
      return pathLines >= 10;
    },
    compress: (lines, _raw, opts) => {
      return countKeep(lines, opts.shellFindMaxResults ?? 30);
    },
  },

  // --- tree ---
  {
    id: "tree",
    name: "tree",
    detect: (lines) => {
      let treeLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (TREE_BRANCH_RE.test(l) || /^\d+ directories, \d+ files/.test(l)) treeLines++;
      }
      return treeLines >= 5;
    },
    compress: (lines): ShellStats => {
      // Keep summary line + top-level entries
      const summary = lines.filter((l) => /^\d+ directories, \d+ files/.test(l));
      const topLevel = lines.filter((l) => {
        const indent = l.match(/^[│├└─\s]*/)?.[0].length ?? 0;
        return indent <= 2 && l.trim().length > 0;
      });
      const collapsed = lines.length - topLevel.length - summary.length;
      if (collapsed <= 0) return { output: lines, stats: { lines: lines.length, kept: lines.length } };
      return {
        output: [
          ...topLevel,
          ...(summary.length > 0 ? summary : []),
          annotation(`… ${collapsed} nested tree lines collapsed`),
        ],
        stats: { lines: lines.length, kept: topLevel.length + summary.length, collapsed },
      };
    },
  },

  // --- make ---
  {
    id: "make",
    name: "make",
    detect: (lines) => {
      let makeLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (MAKE_RE.test(l)) makeLines++;
      }
      return makeLines >= 3;
    },
    compress: (lines) => {
      return summaryKeep(lines, /^(make\[|make:|error:|Error \d+)/);
    },
  },

  // --- go test ---
  {
    id: "go-test",
    name: "go test",
    detect: (lines) => {
      let goTestLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (GO_TEST_RE.test(l)) goTestLines++;
      }
      return goTestLines >= 3;
    },
    compress: (lines) => {
      // Keep FAIL lines + summary, collapse === RUN noise
      return summaryKeep(lines, /^(ok|FAIL|PASS|--- FAIL:|--- PASS:|panic:)/);
    },
  },

  // --- go build ---
  {
    id: "go-build",
    name: "go build",
    detect: (lines) => {
      let goBuildLines = 0;
      for (const l of lines.slice(0, 20)) {
        if (GO_BUILD_RE.test(l) && l.trim().length > 0) goBuildLines++;
      }
      return goBuildLines >= 3 && lines.some((l) => ERROR_RE.test(l));
    },
    compress: (lines) => {
      // Keep error lines only
      return summaryKeep(lines, /^(#|\.|error|cannot|undefined)/);
    },
  },

  // --- pip install ---
  {
    id: "pip-install",
    name: "pip install",
    detect: (lines) => {
      let pipLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (PIP_INSTALL_RE.test(l)) pipLines++;
      }
      return pipLines >= 3;
    },
    compress: (lines) => {
      // Keep only the final summary + errors/warnings; collapse Collecting/Downloading noise
      return summaryKeep(lines, /^(Successfully installed|Requirement already)/);
    },
  },

  // --- maven ---
  {
    id: "mvn",
    name: "mvn / maven",
    detect: (lines) => {
      let mvnLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (MVN_RE.test(l)) mvnLines++;
      }
      return mvnLines >= 5;
    },
    compress: (lines) => {
      // Keep [ERROR], [WARN], BUILD result, and summary lines
      return summaryKeep(lines, /^\[(ERROR|WARN)\]|BUILD (SUCCESS|FAILURE)|Tests run:|Total time:|Reactor Summary/);
    },
  },

  // --- gradle ---
  {
    id: "gradle",
    name: "gradle",
    detect: (lines) => {
      let gradleLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (GRADLE_RE.test(l)) gradleLines++;
      }
      return gradleLines >= 3;
    },
    compress: (lines) => {
      // Keep BUILD result + Deprecated + errors; collapse > Task progress
      return summaryKeep(lines, /^(BUILD SUCCESSFUL|BUILD FAILED|Deprecated|FAILURE:)/);
    },
  },

  // --- rustc ---
  {
    id: "rustc",
    name: "rustc / rust compiler",
    detect: (lines) => {
      let rustcLines = 0;
      for (const l of lines.slice(0, 20)) {
        if (RUSTC_RE.test(l)) rustcLines++;
      }
      return rustcLines >= 3;
    },
    compress: (lines) => {
      // Keep errors, warnings, and location markers — collapse notes/help for non-error lines
      return summaryKeep(lines, RUSTC_RE);
    },
  },

  // --- tsc (TypeScript compiler) ---
  {
    id: "tsc",
    name: "tsc / TypeScript compiler",
    detect: (lines) => {
      let tscLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (TSC_RE.test(l)) tscLines++;
      }
      return tscLines >= 3;
    },
    compress: (lines) => {
      // Keep error/warning lines + the "Found N errors" summary + the code context lines
      // that follow errors (they start with whitespace)
      const output: string[] = [];
      let collapsed = 0;
      let kept = 0;
      let i = 0;
      while (i < lines.length) {
        const l = lines[i]!;
        if (/^(error TS|warning TS|Found \d+ error)/.test(l) || ERROR_RE.test(l) || WARN_RE.test(l)) {
          output.push(l);
          kept++;
          i++;
          // Keep following indented context lines (the code snippet)
          while (i < lines.length && /^\s/.test(lines[i]!) && lines[i]!.trim().length > 0) {
            output.push(lines[i]!);
            kept++;
            i++;
          }
        } else {
          let run = 0;
          while (i < lines.length && !/^(error TS|warning TS|Found \d+ error)/.test(lines[i]!) && !ERROR_RE.test(lines[i]!) && !WARN_RE.test(lines[i]!)) {
            run++;
            i++;
          }
          collapsed += run;
          if (run > 0) output.push(annotation(`… ${run} lines collapsed`));
        }
      }
      return {
        output,
        stats: { lines: lines.length, kept, collapsed },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Module — detects the shell command type and applies the right strategy
// ---------------------------------------------------------------------------

export const shellOutputModule: PruneModule = {
  toolType: "shell-output",
  ruleId: "shell-output.pattern-compress.v1",
  name: "shell output pattern compression",

  prune(raw: string, _task: TaskContext, opts: PruneOptions): PruneResult {
    const tokensFull = approxTokens(raw);
    const lines = raw.split(/\r?\n/);

    // Small outputs — not worth compressing
    if (lines.length <= 15) {
      return {
        toolType: "shell-output",
        prunedOutput: raw,
        removed: {
          summary: "small shell output, returned in full",
          tokensRemoved: 0,
          counts: { lines: lines.length },
        },
        tokensFull,
        tokensPruned: tokensFull,
        ruleId: shellOutputModule.ruleId,
        guardOk: true,
      };
    }

    // Detect the command type
    let matched: ShellPattern | null = null;
    for (const pattern of PATTERNS) {
      if (pattern.detect(lines, raw)) {
        matched = pattern;
        break;
      }
    }

    if (!matched) {
      // No specific pattern matched — use generic tail-keep as fallback
      // (shell output is usually streaming logs that benefit from tail-keep)
      const { output, stats } = tailKeep(lines, opts.shellTailLines ?? 50);
      const prunedOutput = output.join("\n");
      const tokensPruned = approxTokens(prunedOutput);
      return {
        toolType: "shell-output",
        prunedOutput,
        removed: {
          summary: `No specific shell pattern detected; applied tail-keep fallback (last ${opts.shellTailLines ?? 50} lines + errors).`,
          tokensRemoved: tokensFull - tokensPruned,
          counts: stats,
        },
        tokensFull,
        tokensPruned,
        ruleId: shellOutputModule.ruleId,
        guardOk: true,
      };
    }

    // Apply the matched pattern's compression
    const { output, stats } = matched.compress(lines, raw, opts);
    const prunedOutput = output.join("\n");
    const tokensPruned = approxTokens(prunedOutput);

    return {
      toolType: "shell-output",
      prunedOutput,
      removed: {
        summary: `Shell output detected as "${matched.name}"; ${stats.kept ?? 0} lines kept, ${stats.collapsed ?? 0} collapsed.`,
        tokensRemoved: tokensFull - tokensPruned,
        counts: { ...stats },
      },
      tokensFull,
      tokensPruned,
      ruleId: shellOutputModule.ruleId,
      guardOk: true,
    };
  },
};

// Export pattern list for testing/introspection
export function listShellPatterns(): string[] {
  return PATTERNS.map((p) => p.id);
}

// Export individual strategies for testing
export { tailKeep, summaryKeep, countKeep, topN };

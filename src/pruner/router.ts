/**
 * Content-aware router.
 *
 * Auto-detects the content type of a tool output and routes it to the best
 * pruning module. This replaces the manual `toolType` parameter — the caller
 * can pass `generic` and the router figures out what's actually in the output.
 *
 * Detection is heuristic-based (no ML, no external dependencies):
 *   1. JSON arrays/objects → json module (statistical sampling)
 *   2. grep/search output (path:line:content pattern) → grep module
 *   3. Test/build logs (pass/fail/error patterns) → testlog module
 *   4. Source code (import/function/class patterns) → file-read module
 *   5. Fallback → generic module
 *
 * The router also handles mixed content — if the output contains multiple
 * sections (e.g., a test log followed by a grep result), it splits on blank-
 * line boundaries and routes each section independently, then reassembles.
 */
import type { ToolType } from "./types.js";

export interface RouteResult {
  /** The detected tool type. */
  toolType: ToolType;
  /** Confidence in the detection (0..1). */
  confidence: number;
  /** Why this route was chosen (for debugging/display). */
  reason: string;
}

/** Detection patterns — ordered by specificity (most specific first). */
interface Detector {
  toolType: ToolType;
  test: (raw: string, lines: string[]) => boolean;
  reason: string;
  confidence: number;
}

const JSON_DETECTORS: Detector[] = [
  {
    toolType: "json",
    test: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
        return false;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    },
    reason: "valid JSON (parsed successfully)",
    confidence: 0.95,
  },
  {
    toolType: "json",
    test: (raw, lines) => {
      // JSON-like: many lines start with { or [ and end with , or }
      let jsonLines = 0;
      for (const l of lines.slice(0, 50)) {
        const t = l.trim();
        if (
          (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) &&
          (t.endsWith(",") || t.endsWith("}") || t.endsWith("]") ||
            t.endsWith('",'))
        )
          jsonLines++;
      }
      return jsonLines > lines.length * 0.4;
    },
    reason: "JSON-like structure (>40% lines match JSON patterns)",
    confidence: 0.7,
  },
];

const GREP_DETECTORS: Detector[] = [
  {
    toolType: "grep",
    test: (_raw, lines) => {
      // grep output: path:line:content or path:content
      // Need at least 3 lines matching to be confident
      let grepLines = 0;
      for (const l of lines.slice(0, 100)) {
        if (l.trim().length === 0) continue;
        // Unix: path:line:content or path:content
        if (/^[^:\s][^:]*:\d+[:\-]/.test(l)) grepLines++;
        // Windows: C:\path:line:content
        else if (/^[A-Za-z]:[\\\/][^:]*:\d+[:\-]/.test(l)) grepLines++;
      }
      return grepLines >= 3;
    },
    reason: "grep output format (path:line:content pattern detected)",
    confidence: 0.9,
  },
  {
    toolType: "grep",
    test: (_raw, lines) => {
      // ripgrep-style: path:content (no line number) with file grouping
      let matchLines = 0;
      for (const l of lines.slice(0, 100)) {
        if (l.trim().length === 0) continue;
        if (/^[^:\s][^:]*:/.test(l) && !l.startsWith(" ")) matchLines++;
      }
      return matchLines >= 5 && matchLines > lines.length * 0.5;
    },
    reason: "search output format (path:content pattern, >50% of lines)",
    confidence: 0.6,
  },
];

const TESTLOG_DETECTORS: Detector[] = [
  {
    toolType: "test-log",
    test: (_raw, lines) => {
      const text = lines.slice(0, 200).join("\n").toLowerCase();
      // Test frameworks: vitest, jest, mocha, pytest, cargo test, go test
      const testMarkers = [
        "test files",
        "test suites",
        "tests passed",
        "tests failed",
        "passing",
        "failing",
        "✓",
        "✗",
        "passed",
        "failed",
        "vitest",
        "jest",
        "mocha",
        "pytest",
        "cargo test",
        "go test",
        "runner",
        "expect(",
        "describe(",
        "it(",
        "test(",
      ];
      let hits = 0;
      for (const m of testMarkers) if (text.includes(m)) hits++;
      return hits >= 3;
    },
    reason: "test/build log (3+ test framework markers detected)",
    confidence: 0.85,
  },
  {
    toolType: "test-log",
    test: (_raw, lines) => {
      // Build output: compiler errors, make/npm output
      const text = lines.slice(0, 100).join("\n");
      const buildMarkers = [
        "error ts",
        "error:",
        "warning:",
        "compiling",
        "building",
        "npm err",
        "make:",
        "cargo build",
        "webpack",
        "vite",
        "tsc",
        "esbuild",
      ];
      let hits = 0;
      for (const m of buildMarkers) if (text.toLowerCase().includes(m)) hits++;
      return hits >= 2;
    },
    reason: "build output (2+ compiler/build markers detected)",
    confidence: 0.7,
  },
];

const FILERead_DETECTORS: Detector[] = [
  {
    toolType: "file-read",
    test: (_raw, lines) => {
      // Source code: import/export/function/class/const patterns
      const text = lines.slice(0, 50).join("\n");
      const codeMarkers = [
        /^\s*import\s/m,
        /^\s*export\s/m,
        /^\s*from\s+["']/m,
        /^\s*function\s/m,
        /^\s*class\s/m,
        /^\s*const\s/m,
        /^\s*def\s/m,
        /^\s*public\s/m,
        /^\s*private\s/m,
        /^\s*protected\s/m,
      ];
      let hits = 0;
      for (const re of codeMarkers) if (re.test(text)) hits++;
      return hits >= 3;
    },
    reason: "source code (3+ import/function/class patterns detected)",
    confidence: 0.8,
  },
];

// High-confidence shell-output detectors — patterns that are unambiguously
// shell command output (git, docker, npm, cargo, make, mvn, pip, gradle, tsc).
// These are checked BEFORE grep/testlog/file-read because they can't be
// confused with source code or test logs.
const SHELL_OUTPUT_DETECTORS_HIGH: Detector[] = [
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // git log: multiple "commit <hash>" lines
      let commits = 0;
      for (const l of lines.slice(0, 50)) {
        if (/^commit [0-9a-f]{7,40}/.test(l)) commits++;
      }
      return commits >= 2;
    },
    reason: "git log output (multiple commit headers detected)",
    confidence: 0.9,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // git diff: diff --git, +++, ---, @@ patterns
      let diffLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^(diff --git|index |---|\+\+\+|@@)/.test(l)) diffLines++;
      }
      return diffLines >= 3;
    },
    reason: "git diff output (diff headers detected)",
    confidence: 0.9,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // docker/kubectl logs: timestamped log lines
      let tsLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l)) tsLines++;
      }
      return tsLines >= 5;
    },
    reason: "timestamped log output (docker/kubectl logs)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // npm install: added/removed/audited patterns OR +-- package lines
      let npmLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (/^(added|removed|changed|npm warn|npm error|up to date|audited)/.test(l)) npmLines++;
        else if (/^\+--\s|^\+ \S+@/.test(l)) npmLines++;
      }
      return npmLines >= 3;
    },
    reason: "npm install output (package manager summary lines detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // cargo build: Compiling/Finished/warning/error patterns
      let cargoLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^(Compiling|Finished|warning:|error\[|error:)/.test(l)) cargoLines++;
      }
      return cargoLines >= 3;
    },
    reason: "cargo build output (Rust compiler patterns detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // docker build: Step X/Y patterns
      let stepLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (/^Step \d+\/\d+\s*:/.test(l)) stepLines++;
      }
      return stepLines >= 3;
    },
    reason: "docker build output (step markers detected)",
    confidence: 0.9,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // ps aux: USER PID %CPU header
      return /^USER\s+PID\s+%CPU\s+%MEM/.test(lines[0] ?? "") ||
             /^USER\s+PID\s+%CPU\s+%MEM/.test(lines[1] ?? "");
    },
    reason: "ps aux output (process list header detected)",
    confidence: 0.95,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // make output: make[/gcc/cc patterns
      let makeLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^(make\[|make:|gcc|g\+\+|cc |cc1|ld )/.test(l)) makeLines++;
      }
      return makeLines >= 3;
    },
    reason: "make output (compiler/linker patterns detected)",
    confidence: 0.8,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // maven output: [INFO]/[ERROR] patterns
      let mvnLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^\[(INFO|ERROR|WARN)\]/.test(l)) mvnLines++;
      }
      return mvnLines >= 5;
    },
    reason: "maven output ([INFO]/[ERROR] markers detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // pip install: Collecting/Downloading/Installing patterns
      let pipLines = 0;
      for (const l of lines.slice(0, 20)) {
        if (/^(Collecting|Downloading|Installing|Successfully installed)/.test(l)) pipLines++;
      }
      return pipLines >= 3;
    },
    reason: "pip install output (Python package manager patterns detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // gradle output: > Task / BUILD SUCCESSFUL patterns
      let gradleLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^(> Task|> Configure|BUILD SUCCESSFUL|BUILD FAILED)/.test(l)) gradleLines++;
      }
      return gradleLines >= 3;
    },
    reason: "gradle output (task/build markers detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // tsc output: error TS#### / warning TS#### patterns (may be at start
      // or after a file:line:col prefix)
      let tscLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (/(error TS\d+|warning TS\d+)/.test(l)) tscLines++;
      }
      return tscLines >= 3;
    },
    reason: "tsc output (TypeScript compiler errors/warnings detected)",
    confidence: 0.9,
  },
];

// Low-confidence shell-output detectors — patterns that could overlap with
// test logs (go test has PASS/FAIL like vitest) or source code (find output
// has path-like lines like file-read). These are checked AFTER grep/testlog/
// file-read so the more specific detectors win.
const SHELL_OUTPUT_DETECTORS_LOW: Detector[] = [
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // go test: === RUN / --- PASS: / --- FAIL: patterns (Go-specific)
      let goTestLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^(=== RUN|=== PAUSE|=== CONT|--- FAIL:|--- PASS:)/.test(l)) goTestLines++;
      }
      return goTestLines >= 3;
    },
    reason: "go test output (Go test markers detected)",
    confidence: 0.85,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // find output: many absolute/relative path lines (no spaces, no code)
      let pathLines = 0;
      for (const l of lines.slice(0, 50)) {
        if (/^[/~.]/.test(l) && l.trim().length > 0 && !l.startsWith("find:") && !/\s{2,}/.test(l) && !/[{};()]/.test(l)) pathLines++;
      }
      return pathLines >= 10;
    },
    reason: "find output (many path lines detected)",
    confidence: 0.75,
  },
  {
    toolType: "shell-output",
    test: (_raw, lines) => {
      // tree output: branch characters + "N directories, N files"
      let treeLines = 0;
      for (const l of lines.slice(0, 30)) {
        if (/^[│├└─\s]+/.test(l) || /^\d+ directories, \d+ files/.test(l)) treeLines++;
      }
      return treeLines >= 5;
    },
    reason: "tree output (branch characters detected)",
    confidence: 0.8,
  },
];

// Order matters: most specific first. JSON is checked first because valid JSON
// is unambiguous. Then high-confidence shell-output detectors (git, docker, npm,
// cargo, etc. — can't be confused with code or test logs). Then grep (path:line
// pattern). Then test logs (test markers). Then file-read (code patterns).
// Then low-confidence shell-output detectors (go test, find, tree — patterns
// that overlap with test logs and source code). Generic is the fallback.
const ALL_DETECTORS = [
  ...JSON_DETECTORS,
  ...SHELL_OUTPUT_DETECTORS_HIGH,
  ...GREP_DETECTORS,
  ...TESTLOG_DETECTORS,
  ...FILERead_DETECTORS,
  ...SHELL_OUTPUT_DETECTORS_LOW,
];

/**
 * Detect the content type of a tool output and return the best tool type.
 * If no detector matches, returns "generic".
 */
export function routeContent(raw: string): RouteResult {
  const lines = raw.split(/\r?\n/);

  // Skip detection for very small outputs — not worth the overhead.
  if (lines.length < 5) {
    return {
      toolType: "generic",
      confidence: 0.5,
      reason: "small output (<5 lines), using generic",
    };
  }

  for (const detector of ALL_DETECTORS) {
    if (detector.test(raw, lines)) {
      return {
        toolType: detector.toolType,
        confidence: detector.confidence,
        reason: detector.reason,
      };
    }
  }

  return {
    toolType: "generic",
    confidence: 0.3,
    reason: "no specific pattern detected, using generic fallback",
  };
}

/**
 * Detect content type for each section of a mixed output.
 * Splits on blank-line boundaries (2+ consecutive blank lines) and routes
 * each section independently. Returns the dominant tool type + per-section info.
 *
 * This handles outputs like:
 *   - Test results followed by grep results
 *   - Build log followed by test output
 *   - File content followed by error messages
 */
export function routeMixedContent(
  raw: string,
): RouteResult & {
  sections: Array<{ toolType: ToolType; lineRange: [number, number] }>;
} {
  const lines = raw.split(/\r?\n/);

  // Find section boundaries (2+ consecutive blank lines)
  const boundaries: number[] = [0];
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length === 0) {
      blankRun++;
      if (blankRun >= 2 && i + 1 < lines.length) {
        boundaries.push(i + 1);
        blankRun = 0;
      }
    } else {
      blankRun = 0;
    }
  }
  boundaries.push(lines.length);

  // Route each section
  const sections: Array<{ toolType: ToolType; lineRange: [number, number] }> =
    [];
  const sectionTypes: ToolType[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    const sectionText = lines.slice(start, end).join("\n");
    const route = routeContent(sectionText);
    sections.push({ toolType: route.toolType, lineRange: [start, end] });
    sectionTypes.push(route.toolType);
  }

  // Pick the dominant tool type (most common among sections)
  const counts = new Map<ToolType, number>();
  for (const t of sectionTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  let dominant: ToolType = "generic";
  let maxCount = 0;
  for (const [t, c] of counts) {
    if (c > maxCount) {
      dominant = t;
      maxCount = c;
    }
  }

  return {
    toolType: dominant,
    confidence: sections.length === 1 ? 0.8 : 0.6,
    reason:
      sections.length === 1
        ? "single content type detected"
        : `mixed content (${sections.length} sections, dominant: ${dominant})`,
    sections,
  };
}

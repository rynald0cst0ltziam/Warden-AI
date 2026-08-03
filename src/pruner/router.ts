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

// Order matters: most specific first. JSON is checked first because valid JSON
// is unambiguous. Then grep (path:line pattern is very specific). Then test
// logs (test markers are distinctive). Then file-read (code patterns). Generic
// is the fallback.
const ALL_DETECTORS = [
  ...JSON_DETECTORS,
  ...GREP_DETECTORS,
  ...TESTLOG_DETECTORS,
  ...FILERead_DETECTORS,
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

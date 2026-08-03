/**
 * Layer 1 — input context selection.
 *
 * BEFORE the agent starts working, Warden recommends what files / context to
 * load. This module scans the project tree and returns a ranked list of files
 * likely relevant to the task, using cheap local heuristics:
 *
 *   1. Name match — does the task mention a filename or module name?
 *   2. Extension relevance — code vs docs vs tests.
 *   3. Recency — recently modified files get a boost (mtime).
 *   4. Test association — if the task mentions "test" / "fix", pull in nearby
 *      test files for matched files.
 *   5. Directory proximity — files in the same directory as a name match get a
 *      small boost (they're likely collaborators).
 *
 * No external dependencies — only Node built-ins. Every selection is recorded
 * to the store (when one is supplied) for the audit trail.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

export interface ContextRecommendation {
  filePath: string;
  reason: string;
  relevance: number; // 0..1
}

/** A extracted slice from a file — actual code, verbatim. */
export interface ContextSlice {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  reason: string;
}

/** A structural outline entry for the parts of a file we didn't include. */
export interface ContextOutlineEntry {
  line: number;
  header: string;
}

/** A single file's compact representation in the context package. */
export interface ContextFile {
  filePath: string;
  relevance: number;
  reason: string;
  /** Verbatim code slices that are relevant to the task. */
  slices: ContextSlice[];
  /** Structural headers from the rest of the file (so the agent knows the shape). */
  outline: ContextOutlineEntry[];
  /** Total lines in the full file. */
  totalLines: number;
  /** Lines included in slices. */
  linesIncluded: number;
}

export interface ContextSelectionResult {
  task: string;
  recommendations: ContextRecommendation[];
  reasoning: string;
  /** The compact context package — actual code snippets + outlines. */
  package: ContextFile[];
  /** Total tokens in the full files (if we'd read them entirely). */
  tokensFull: number;
  /** Tokens in the compact package (slices + outlines only). */
  tokensCompact: number;
  /** Percentage reduction. */
  reductionPct: number;
}

export interface ContextStore {
  saveContextSelection: (opts: {
    task: string;
    files: string[];
    reasoning?: string;
  }) => void;
}

/**
 * Optional code-index interface for 2-hop symbol expansion.
 * When the store supports this, selectContext enriches recommendations
 * with dependency signatures (function/class signatures of imported files).
 */
export interface CodeIndexStore {
  /** Get resolved import paths for a file (what it imports). */
  getImportsForFile(filePath: string, repoRoot: string): string[];
  /** Get symbol signatures for a file (name, kind, params, exported). */
  getSymbolsForFile(filePath: string, repoRoot: string): Array<{
    name: string;
    kind: string;
    params: string[];
    exported: boolean;
  }>;
  /** Check if the code index has been populated for this project. */
  hasIndex(repoRoot: string): boolean;
}

export async function selectContext(opts: {
  task: string;
  repoRoot: string;
  maxFiles?: number;
  store?: ContextStore;
  codeIndex?: CodeIndexStore;
}): Promise<ContextSelectionResult> {
  const { task, repoRoot, store } = opts;
  const codeIndex = opts.codeIndex;
  const maxFiles = opts.maxFiles ?? 15;

  const tokens = extractTokens(task);
  const wantsTests = /\b(test|fix|bug|fail|regression|broken)\b/i.test(task);

  const files = scanProject(repoRoot);
  const now = Date.now();
  // Use the freshest file as the recency reference so the recency boost is
  // relative to the project's actual activity, not wall-clock epoch.
  const newestMtime = files.reduce((acc, f) => Math.max(acc, f.mtimeMs), 0);

  // First, discover which directories contain name matches. Directory
  // proximity (signal 5) depends on ALL name matches, not just the current
  // file, so we compute this set once before scoring.
  const matchedDirs = new Set<string>();
  for (const f of files) {
    const name = basename(f.relPath);
    const dir = parentDir(f.relPath);
    if (!dir) continue;
    if (matchesToken(name, f.relPath, tokens)) {
      matchedDirs.add(dir);
    }
  }

  const scored: ContextRecommendation[] = files.map((f) => {
    const rel = f.relPath;
    const name = basename(rel);
    const ext = extname(rel);
    const dir = parentDir(rel);

    let score = 0;
    const reasons: string[] = [];

    // 1. Name / module match — strongest signal.
    let nameHit = false;
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      const lowerName = name.toLowerCase();
      const lowerRel = rel.toLowerCase();
      // Direct filename mention ("auth.ts", "auth.py", "auth.go", etc).
      const ext = extname(lowerName);
      const stem = ext ? lowerName.slice(0, -ext.length) : lowerName;
      if (stem === tok) {
        score += 0.5;
        nameHit = true;
        reasons.push(`filename matches "${tok}"`);
        break;
      }
      // Filename contains the token ("auth" in "auth.ts", "auth-login.ts").
      if (lowerName.includes(tok)) {
        score += 0.35;
        nameHit = true;
        reasons.push(`filename contains "${tok}"`);
        break;
      }
      // Path segment matches the token ("auth" in "src/auth/login.ts").
      // Check both platform sep and forward slash for cross-platform support.
      // On Windows, relative() produces paths with \, but we also check /
      // to handle paths that were already normalized.
      if (
        lowerRel.includes(`${sep}${tok}${sep}`) ||
        lowerRel.includes(`/${tok}/`) ||
        lowerRel.startsWith(`${tok}${sep}`) ||
        lowerRel.startsWith(`${tok}/`)
      ) {
        score += 0.25;
        nameHit = true;
        reasons.push(`path segment "${tok}"`);
        break;
      }
    }

    // 2. Extension relevance — give a small boost to any recognized file type.
    // Name/path matches (signal 1) are the primary driver; this just breaks
    // ties between equally-named files of different types.
    if (SCORING_CODE_EXTS.has(ext)) {
      score += 0.05;
      if (!reasons.length) reasons.push("source file");
    } else if (ext === ".md" || ext === ".mdx") {
      score += 0.04;
      if (!reasons.length) reasons.push("documentation");
    } else if (DATA_EXTS.has(ext)) {
      score += 0.04;
      if (!reasons.length) reasons.push("data/config file");
    } else if (ext === ".txt") {
      score += 0.03;
      if (!reasons.length) reasons.push("text file");
    }

    // 3. Recency — exponential decay over the last ~30 days relative to the
    // newest file in the repo. Files older than that get near-zero boost.
    if (newestMtime > 0) {
      const ageDays = Math.max(0, (now - f.mtimeMs) / DAY_MS);
      const refAgeDays = Math.max(0, (now - newestMtime) / DAY_MS);
      const recency = Math.exp(-(ageDays - refAgeDays) / 30);
      if (recency > 0.1) {
        score += recency * 0.1;
        if (ageDays < 7 && !reasons.length) reasons.push("recently modified");
      }
    }

    // 4. Test association.
    const isTest = isTestFile(name);
    // If the task wants tests and this is a test file that itself matched,
    // boost it strongly.
    if (wantsTests && isTest && nameHit) {
      score += 0.2;
      reasons.push("test file for a matched module");
    }
    // If a name-matched source file exists elsewhere in this directory, pull
    // in sibling test files even when this file itself wasn't a name hit.
    if (wantsTests && isTest && !nameHit && dir && matchedDirs.has(dir)) {
      score += 0.12;
      reasons.push("test file near a matched module");
    }

    // 5. Directory proximity — files in the same directory as any name match
    // get a small boost (collaborators / co-located helpers).
    if (!nameHit && dir && matchedDirs.has(dir)) {
      score += 0.08;
      if (!reasons.length) reasons.push("same directory as a matched file");
    }

    // Penalise unrelated test files — they're noise when the task isn't
    // about testing.
    if (isTest && !wantsTests) {
      score *= 0.5;
    }

    score = clamp01(score);
    return {
      filePath: f.absPath,
      reason: reasons.length ? reasons.join("; ") : "low-confidence candidate",
      relevance: score,
    };
  });

  const ranked = scored
    .filter((r) => r.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxFiles);

  const reasoning = buildReasoning(task, ranked, tokens, wantsTests);

  if (store) {
    try {
      store.saveContextSelection({
        task,
        files: ranked.map((r) => r.filePath),
        reasoning,
      });
    } catch {
      // Store failures must never break context selection.
    }
  }

  // ---- Build the compact context package ----
  // Read the top-ranked files and extract relevant sections + outlines.
  // This is what makes Layer 1 a real compression layer: instead of "read
  // these 5 files" (which could be 2000 lines), we return the actual
  // relevant code snippets + structural outlines of the rest.
  const topFiles = ranked.slice(0, Math.min(maxFiles, 15));
  const pkg: ContextFile[] = [];
  let tokensFull = 0;
  let tokensCompact = 0;

  for (const rec of topFiles) {
    const fileResult = extractRelevantSections(rec.filePath, tokens, task);
    if (fileResult) {
      pkg.push(fileResult);
      tokensFull += fileResult.totalLines * 8; // rough token estimate
      tokensCompact += fileResult.linesIncluded * 8;
      for (const ol of fileResult.outline) {
        tokensCompact += Math.ceil(ol.header.length / 4);
      }
    }
  }

  // ---- 2-hop symbol expansion ----
  // If a code index is available, for each recommended file, look up its
  // imports and include the symbol signatures (not bodies) of direct
  // dependencies. This gives the agent the function/class signatures it
  // will likely need without reading the full dependency files.
  if (codeIndex && codeIndex.hasIndex(repoRoot) && pkg.length > 0) {
    const existingPaths = new Set(
      pkg.map((f) => f.filePath.replace(/\\/g, "/")),
    );
    const expanded: ContextFile[] = [];
    let expandedTokens = 0;

    for (const file of pkg) {
      const relPath = relative(repoRoot, file.filePath).replace(/\\/g, "/");
      const imports = codeIndex.getImportsForFile(relPath, repoRoot);

      for (const impPath of imports) {
        // Skip if already in the package, or already expanded
        const normalized = impPath.replace(/\\/g, "/");
        if (existingPaths.has(normalized)) continue;
        if (expanded.some((e) => e.filePath.replace(/\\/g, "/") === normalized))
          continue;
        // Limit to 8 dependency files to avoid explosion
        if (expanded.length >= 8) break;

        const symbols = codeIndex.getSymbolsForFile(impPath, repoRoot);
        if (symbols.length === 0) continue;

        // Build outline entries from symbol signatures
        const outline: ContextOutlineEntry[] = symbols.map((s) => ({
          line: 0, // line 0 = signature-only, no code slice
          header: formatSymbolSignature(s),
        }));

        const depFile: ContextFile = {
          filePath: join(repoRoot, impPath),
          relevance: 0.3,
          reason: `dependency of ${basename(relPath)}`,
          slices: [], // no code slices — signatures only
          outline,
          totalLines: 0,
          linesIncluded: 0,
        };

        expanded.push(depFile);
        existingPaths.add(normalized);
        const sigTokens = outline.reduce(
          (acc, ol) => acc + Math.ceil(ol.header.length / 4),
          0,
        );
        expandedTokens += sigTokens;
      }
    }

    if (expanded.length > 0) {
      pkg.push(...expanded);
      tokensCompact += expandedTokens;
      // Dependency signatures add to the "full" estimate too —
      // the agent would have had to read these files to see the signatures.
      tokensFull += expandedTokens * 4; // signatures are ~4x smaller than full files
    }
  }

  const reductionPct =
    tokensFull > 0 ? Math.round((1 - tokensCompact / tokensFull) * 100) : 0;

  return {
    task,
    recommendations: ranked,
    reasoning,
    package: pkg,
    tokensFull,
    tokensCompact,
    reductionPct,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Code structural header patterns. Only matches top-level declarations
 * (zero or minimal indentation) to avoid matching const/type/var inside
 * function bodies. The fileread pruner uses a similar but more permissive
 * pattern — here we need precision because we're extracting blocks.
 */
const CODE_HEADER_RE =
  /^(export\s+)?(async\s+)?(function|class|def|interface|type|enum|struct|impl|pub fn|fn)\b.*$/;

/** Markdown section headers. */
const MD_HEADER_RE = /^(#{1,6})\s+(.+)$/;

/** Max lines to include per file in the context package. */
const MAX_LINES_PER_FILE = 200;
/** Max slices per file. */
const MAX_SLICES_PER_FILE = 7;
/** Max outline entries per file. */
const MAX_OUTLINE_PER_FILE = 30;

/** File types and their extraction strategies. */
type FileKind = "code" | "markdown" | "data" | "text" | "config";

function classifyFile(filePath: string): FileKind {
  const ext = extname(filePath).toLowerCase();
  if (MD_EXTS.has(ext)) return "markdown";
  if (DATA_EXTS.has(ext)) return "data";
  if (CONFIG_EXTS.has(ext)) return "config";
  if (CODE_EXTS.has(ext)) return "code";
  return "text";
}

const MD_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".txt"]);
const DATA_EXTS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".xml",
  ".svg",
]);
const CONFIG_EXTS = new Set([
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".editorconfig",
]);
const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".swift",
  ".kt",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".erl",
  ".elm",
  ".lua",
  ".php",
  ".pl",
  ".r",
  ".dart",
  ".vue",
  ".svelte",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".gql",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
]);

/**
 * Read a file and extract the sections relevant to the task tokens.
 * Uses different extraction strategies based on file type:
 *   - code: structural blocks (function/class/etc) + outline of other headers
 *   - markdown: sections (## headers) + outline of other section headers
 *   - data/config: key-value context windows around token matches
 *   - text: line-level matching with surrounding context
 *
 * Returns verbatim slices + a structural outline of the rest.
 * This is what makes Layer 1 a real compression layer.
 */
function extractRelevantSections(
  filePath: string,
  tokens: string[],
  task: string,
): ContextFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;

  // If the file is small, include it entirely as one slice.
  if (totalLines <= 50) {
    return {
      filePath,
      relevance: 1,
      reason: "small file, included in full",
      slices: [
        {
          filePath,
          startLine: 1,
          endLine: totalLines,
          code: raw,
          reason: "full file (small)",
        },
      ],
      outline: [],
      totalLines,
      linesIncluded: totalLines,
    };
  }

  const taskTokens = [
    ...tokens,
    ...task
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2),
  ];

  const kind = classifyFile(filePath);
  let result: { slices: ContextSlice[]; outline: ContextOutlineEntry[] };

  switch (kind) {
    case "markdown":
      result = extractMarkdownSections(lines, taskTokens, filePath);
      break;
    case "data":
    case "config":
      result = extractDataSections(lines, taskTokens, filePath);
      break;
    case "text":
      result = extractTextSections(lines, taskTokens, filePath);
      break;
    case "code":
    default:
      result = extractCodeBlocks(lines, taskTokens, filePath);
      break;
  }

  const linesIncluded = result.slices.reduce(
    (sum, s) => sum + (s.endLine - s.startLine + 1),
    0,
  );

  return {
    filePath,
    relevance: 1,
    reason: `${result.slices.length} slice(s) + ${result.outline.length} outline entries`,
    slices: result.slices,
    outline: result.outline,
    totalLines,
    linesIncluded,
  };
}

// ---------------------------------------------------------------------------
// Code extraction — structural blocks (function/class/etc)
// ---------------------------------------------------------------------------

function extractCodeBlocks(
  lines: string[],
  taskTokens: string[],
  filePath: string,
): { slices: ContextSlice[]; outline: ContextOutlineEntry[] } {
  const slices: ContextSlice[] = [];
  const includedLineSet = new Set<number>();

  // Walk the file looking for header lines, then check if the block contains
  // any task tokens. If it does, include the whole block as a slice.
  let i = 0;
  while (i < lines.length && slices.length < MAX_SLICES_PER_FILE) {
    const line = lines[i]!;
    if (CODE_HEADER_RE.test(line)) {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      let blockEnd = i;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]!;
        if (CODE_HEADER_RE.test(nextLine)) {
          const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
          if (nextIndent <= indent) break;
        }
        blockEnd = j;
      }

      const blockText = lines
        .slice(i, blockEnd + 1)
        .join("\n")
        .toLowerCase();
      const hasToken = taskTokens.some((t) =>
        blockText.includes(t.toLowerCase()),
      );

      if (hasToken) {
        const sliceLines = lines.slice(i, blockEnd + 1);
        if (includedLineSet.size + sliceLines.length > MAX_LINES_PER_FILE)
          break;
        slices.push({
          filePath,
          startLine: i + 1,
          endLine: blockEnd + 1,
          code: sliceLines.join("\n"),
          reason: `code block contains task token(s)`,
        });
        for (let k = i; k <= blockEnd; k++) includedLineSet.add(k);
      }
      i = blockEnd + 1;
    } else {
      i++;
    }
  }

  // Fallback 1: if no blocks matched by header, search for token matches at
  // the line level and include context windows around them. This catches
  // cases where the relevant code is inside a block whose header doesn't
  // match (e.g. a function named "handleRequest" that contains "auth" inside).
  if (slices.length === 0) {
    const CONTEXT_LINES = 5;
    const matchLines: number[] = [];
    for (let j = 0; j < lines.length; j++) {
      const lineText = lines[j]!.toLowerCase();
      if (taskTokens.some((t) => lineText.includes(t.toLowerCase()))) {
        matchLines.push(j);
      }
    }
    // Group nearby matches into slices (merge overlapping context windows).
    for (const matchLine of matchLines) {
      if (slices.length >= MAX_SLICES_PER_FILE) break;
      const start = Math.max(0, matchLine - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, matchLine + CONTEXT_LINES);
      const existing = slices.find(
        (s) => s.startLine - 1 <= end + 1 && s.endLine - 1 >= start - 1,
      );
      if (existing) {
        const newStart = Math.min(existing.startLine - 1, start);
        const newEnd = Math.max(existing.endLine - 1, end);
        existing.startLine = newStart + 1;
        existing.endLine = newEnd + 1;
        existing.code = lines.slice(newStart, newEnd + 1).join("\n");
        for (let k = newStart; k <= newEnd; k++) includedLineSet.add(k);
      } else {
        const sliceLines = lines.slice(start, end + 1);
        if (includedLineSet.size + sliceLines.length > MAX_LINES_PER_FILE)
          break;
        slices.push({
          filePath,
          startLine: start + 1,
          endLine: end + 1,
          code: sliceLines.join("\n"),
          reason: `line-level token match with context`,
        });
        for (let k = start; k <= end; k++) includedLineSet.add(k);
      }
    }
  }

  // Fallback 2: if still no slices (no token matches at all), include the
  // head (imports + first block) so the agent at least sees the file structure.
  if (slices.length === 0) {
    const headEnd = Math.min(30, lines.length);
    const headLines = lines.slice(0, headEnd);
    slices.push({
      filePath,
      startLine: 1,
      endLine: headEnd,
      code: headLines.join("\n"),
      reason: "file head (no token matches found)",
    });
    for (let k = 0; k < headEnd; k++) includedLineSet.add(k);
  }

  // Build the outline from code headers NOT included in any slice.
  const outline: ContextOutlineEntry[] = [];
  for (
    let j = 0;
    j < lines.length && outline.length < MAX_OUTLINE_PER_FILE;
    j++
  ) {
    if (CODE_HEADER_RE.test(lines[j]!) && !includedLineSet.has(j)) {
      outline.push({ line: j + 1, header: lines[j]!.trim() });
    }
  }

  return { slices, outline };
}

// ---------------------------------------------------------------------------
// Markdown extraction — sections (## headers) with their content
// ---------------------------------------------------------------------------

function extractMarkdownSections(
  lines: string[],
  taskTokens: string[],
  filePath: string,
): { slices: ContextSlice[]; outline: ContextOutlineEntry[] } {
  const slices: ContextSlice[] = [];
  const includedLineSet = new Set<number>();

  // Find section boundaries (any # header).
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (MD_HEADER_RE.test(lines[i]!)) {
      sectionStarts.push(i);
    }
  }

  // If no headers, treat as plain text.
  if (sectionStarts.length === 0) {
    return extractTextSections(lines, taskTokens, filePath);
  }

  // For each section, check if the header or content contains task tokens.
  for (
    let s = 0;
    s < sectionStarts.length && slices.length < MAX_SLICES_PER_FILE;
    s++
  ) {
    const start = sectionStarts[s]!;
    const end =
      s + 1 < sectionStarts.length
        ? sectionStarts[s + 1]! - 1
        : lines.length - 1;
    const sectionText = lines
      .slice(start, end + 1)
      .join("\n")
      .toLowerCase();
    const hasToken = taskTokens.some((t) =>
      sectionText.includes(t.toLowerCase()),
    );

    if (hasToken) {
      const sliceLines = lines.slice(start, end + 1);
      if (includedLineSet.size + sliceLines.length > MAX_LINES_PER_FILE) break;
      slices.push({
        filePath,
        startLine: start + 1,
        endLine: end + 1,
        code: sliceLines.join("\n"),
        reason: `section contains task token(s)`,
      });
      for (let k = start; k <= end; k++) includedLineSet.add(k);
    }
  }

  // Fallback: include the first section (usually the title + intro).
  if (slices.length === 0) {
    const firstEnd =
      sectionStarts.length > 1
        ? sectionStarts[1]! - 1
        : Math.min(30, lines.length - 1);
    const headLines = lines.slice(0, firstEnd + 1);
    slices.push({
      filePath,
      startLine: 1,
      endLine: firstEnd + 1,
      code: headLines.join("\n"),
      reason: "document head (no section matched task tokens)",
    });
    for (let k = 0; k <= firstEnd; k++) includedLineSet.add(k);
  }

  // Outline = all section headers not included in a slice.
  const outline: ContextOutlineEntry[] = [];
  for (
    let j = 0;
    j < lines.length && outline.length < MAX_OUTLINE_PER_FILE;
    j++
  ) {
    if (MD_HEADER_RE.test(lines[j]!) && !includedLineSet.has(j)) {
      outline.push({ line: j + 1, header: lines[j]!.trim() });
    }
  }

  return { slices, outline };
}

// ---------------------------------------------------------------------------
// Data/config extraction — context windows around token matches
// ---------------------------------------------------------------------------

function extractDataSections(
  lines: string[],
  taskTokens: string[],
  filePath: string,
): { slices: ContextSlice[]; outline: ContextOutlineEntry[] } {
  const slices: ContextSlice[] = [];
  const includedLineSet = new Set<number>();

  // For data files, find lines containing task tokens and include
  // surrounding context (a few lines before and after).
  const CONTEXT_LINES = 3;
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.toLowerCase();
    if (taskTokens.some((t) => lineText.includes(t.toLowerCase()))) {
      matchLines.push(i);
    }
  }

  // Group nearby matches into slices (merge overlapping context windows).
  for (const matchLine of matchLines) {
    if (slices.length >= MAX_SLICES_PER_FILE) break;
    const start = Math.max(0, matchLine - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, matchLine + CONTEXT_LINES);

    // Check if this overlaps with an existing slice — if so, extend it.
    const existing = slices.find(
      (s) => s.startLine - 1 <= end + 1 && s.endLine - 1 >= start - 1,
    );
    if (existing) {
      const newStart = Math.min(existing.startLine - 1, start);
      const newEnd = Math.max(existing.endLine - 1, end);
      existing.startLine = newStart + 1;
      existing.endLine = newEnd + 1;
      existing.code = lines.slice(newStart, newEnd + 1).join("\n");
      for (let k = newStart; k <= newEnd; k++) includedLineSet.add(k);
    } else {
      const sliceLines = lines.slice(start, end + 1);
      if (includedLineSet.size + sliceLines.length > MAX_LINES_PER_FILE) break;
      slices.push({
        filePath,
        startLine: start + 1,
        endLine: end + 1,
        code: sliceLines.join("\n"),
        reason: `context around token match`,
      });
      for (let k = start; k <= end; k++) includedLineSet.add(k);
    }
  }

  // Fallback: include the first 30 lines.
  if (slices.length === 0) {
    const headEnd = Math.min(30, lines.length);
    slices.push({
      filePath,
      startLine: 1,
      endLine: headEnd,
      code: lines.slice(0, headEnd).join("\n"),
      reason: "file head (no token matches found)",
    });
    for (let k = 0; k < headEnd; k++) includedLineSet.add(k);
  }

  // For data files, the "outline" is the first line of each slice region
  // plus any top-level keys/headers we can detect.
  const outline: ContextOutlineEntry[] = [];
  // For JSON, look for top-level keys.
  for (
    let j = 0;
    j < lines.length && outline.length < MAX_OUTLINE_PER_FILE;
    j++
  ) {
    if (includedLineSet.has(j)) continue;
    const line = lines[j]!;
    // JSON/YAML key detection.
    const keyMatch = line.match(
      /^\s*["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]/,
    );
    if (keyMatch) {
      outline.push({ line: j + 1, header: line.trim() });
    }
  }

  return { slices, outline };
}

// ---------------------------------------------------------------------------
// Text extraction — line-level matching with context windows
// ---------------------------------------------------------------------------

function extractTextSections(
  lines: string[],
  taskTokens: string[],
  filePath: string,
): { slices: ContextSlice[]; outline: ContextOutlineEntry[] } {
  const slices: ContextSlice[] = [];
  const includedLineSet = new Set<number>();

  // For plain text, find lines containing task tokens and include
  // surrounding context. Also treat blank-line-separated paragraphs as blocks.
  const CONTEXT_LINES = 2;
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.toLowerCase();
    if (taskTokens.some((t) => lineText.includes(t.toLowerCase()))) {
      matchLines.push(i);
    }
  }

  // Group nearby matches into slices.
  for (const matchLine of matchLines) {
    if (slices.length >= MAX_SLICES_PER_FILE) break;
    // Expand to paragraph boundaries (blank lines).
    let start = matchLine;
    while (start > 0 && lines[start - 1]!.trim().length > 0) start--;
    let end = matchLine;
    while (end < lines.length - 1 && lines[end + 1]!.trim().length > 0) end++;
    // Also add a small context margin.
    start = Math.max(0, start - CONTEXT_LINES);
    end = Math.min(lines.length - 1, end + CONTEXT_LINES);

    // Merge with existing slice if overlapping.
    const existing = slices.find(
      (s) => s.startLine - 1 <= end + 1 && s.endLine - 1 >= start - 1,
    );
    if (existing) {
      const newStart = Math.min(existing.startLine - 1, start);
      const newEnd = Math.max(existing.endLine - 1, end);
      existing.startLine = newStart + 1;
      existing.endLine = newEnd + 1;
      existing.code = lines.slice(newStart, newEnd + 1).join("\n");
      for (let k = newStart; k <= newEnd; k++) includedLineSet.add(k);
    } else {
      const sliceLines = lines.slice(start, end + 1);
      if (includedLineSet.size + sliceLines.length > MAX_LINES_PER_FILE) break;
      slices.push({
        filePath,
        startLine: start + 1,
        endLine: end + 1,
        code: sliceLines.join("\n"),
        reason: `paragraph contains task token(s)`,
      });
      for (let k = start; k <= end; k++) includedLineSet.add(k);
    }
  }

  // Fallback: include the first 30 lines.
  if (slices.length === 0) {
    const headEnd = Math.min(30, lines.length);
    slices.push({
      filePath,
      startLine: 1,
      endLine: headEnd,
      code: lines.slice(0, headEnd).join("\n"),
      reason: "file head (no token matches found)",
    });
    for (let k = 0; k < headEnd; k++) includedLineSet.add(k);
  }

  // For text files, the outline is the first line of each paragraph not included.
  const outline: ContextOutlineEntry[] = [];
  let inParagraph = false;
  for (
    let j = 0;
    j < lines.length && outline.length < MAX_OUTLINE_PER_FILE;
    j++
  ) {
    const line = lines[j]!;
    const isBlank = line.trim().length === 0;
    if (!isBlank && !inParagraph && !includedLineSet.has(j)) {
      // Start of a new paragraph not included in any slice.
      outline.push({ line: j + 1, header: line.trim().slice(0, 80) });
      inParagraph = true;
    } else if (isBlank) {
      inParagraph = false;
    }
  }

  return { slices, outline };
}

const SCORING_CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".swift",
  ".kt",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".erl",
  ".elm",
  ".lua",
  ".php",
  ".pl",
  ".r",
  ".dart",
  ".vue",
  ".svelte",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".gql",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "target",
  ".idea",
  ".vscode",
]);

/**
 * Secret / credential files that must never be auto-surfaced by context
 * selection. Matches .env and its variants (.env.local, .env.production),
 * key material, and well-known credential files. The agent can still read
 * one explicitly via warden_file_read if the user asks — this only stops
 * Warden from proactively pulling secrets into context during a scan.
 */
function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".pfx"))
    return true;
  if (lower === "id_rsa" || lower === "id_ed25519" || lower === ".npmrc")
    return true;
  if (lower === "credentials" || lower === ".netrc" || lower === ".pgpass")
    return true;
  if (lower.endsWith(".p12") || lower.endsWith(".keystore")) return true;
  return false;
}

interface ScannedFile {
  absPath: string;
  relPath: string;
  mtimeMs: number;
}

/** Walk the project tree, respecting .gitignore-style skip dirs. */
function scanProject(repoRoot: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        stack.push(abs);
      } else if (st.isFile()) {
        // Never surface secret files during proactive context scanning.
        // The user didn't ask for these — auto-including them would leak
        // credentials into the model's context.
        if (isSecretFile(entry)) continue;
        out.push({
          absPath: abs,
          relPath: relative(repoRoot, abs),
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  return out;
}

/** Return the directory portion of a relative path ("" if none). */
function parentDir(relPath: string): string {
  // Handle both platform separator and forward slash
  const idxSep = relPath.lastIndexOf(sep);
  const idxSlash = relPath.lastIndexOf("/");
  const idx = Math.max(idxSep, idxSlash);
  return idx >= 0 ? relPath.slice(0, idx) : "";
}

/** Does a file's name or path match any of the task tokens? */
function matchesToken(
  name: string,
  relPath: string,
  tokens: string[],
): boolean {
  const lowerName = name.toLowerCase();
  const lowerRel = relPath.toLowerCase();
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (
      lowerName === `${tok}.ts` ||
      lowerName === `${tok}.tsx` ||
      lowerName.includes(tok) ||
      lowerRel.includes(`${sep}${tok}${sep}`) ||
      lowerRel.includes(`/${tok}/`)
    ) {
      return true;
    }
  }
  return false;
}

/** Extract candidate module / filename tokens from the task description. */
function extractTokens(task: string): string[] {
  // Pull out bare words, drop stopwords, keep anything that looks like a
  // module name or filename fragment.
  const stop = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "and",
    "or",
    "fix",
    "add",
    "update",
    "remove",
    "refactor",
    "implement",
    "create",
    "change",
    "make",
    "use",
    "with",
    "that",
    "this",
    "it",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "not",
    "no",
    "do",
    "does",
    "did",
    "can",
    "should",
    "would",
    "could",
    "will",
    "may",
    "might",
    "must",
    "shall",
    "we",
    "you",
    "they",
    "he",
    "she",
    "i",
    "me",
    "my",
    "our",
    "your",
    "their",
    "file",
    "files",
    "code",
    "function",
    "functions",
    "method",
    "methods",
    "class",
    "classes",
    "module",
    "modules",
    "bug",
    "error",
    "issue",
    "problem",
    "test",
    "tests",
    "feature",
    "task",
    "null",
    "pointer",
    "stack",
    "trace",
    "crash",
    "fail",
    "failing",
    "broken",
    "wrong",
    "regression",
  ]);
  const raw = task
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .filter(Boolean);
  // Also extract explicit filename-like tokens ("auth.ts" -> "auth" + "auth.ts").
  const fileLike = task.match(/[a-z0-9_-]+\.(ts|tsx|js|jsx|py|go|rs|md)/gi);
  const tokens = new Set<string>();
  for (const w of raw) {
    if (w.length >= 2 && !stop.has(w)) tokens.add(w);
  }
  if (fileLike) {
    for (const f of fileLike) {
      if (f === undefined) continue;
      tokens.add(f.toLowerCase());
      const stem = f
        .toLowerCase()
        .replace(/\.(ts|tsx|js|jsx|py|go|rs|md)$/i, "");
      if (stem) tokens.add(stem);
    }
  }
  return [...tokens];
}

function isTestFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i.test(name) ||
    lower.includes("_test.go") ||
    lower.startsWith("test_") ||
    lower.endsWith(".test.ts")
  );
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function buildReasoning(
  task: string,
  ranked: ContextRecommendation[],
  tokens: string[],
  wantsTests: boolean,
): string {
  if (ranked.length === 0) {
    return (
      `No files matched the task "${task}" with sufficient confidence. ` +
      `Consider providing a more specific filename or module name.`
    );
  }
  const top = ranked[0];
  const topDesc = top
    ? `"${top.filePath}" (${top.reason}, relevance ${top.relevance.toFixed(2)})`
    : "n/a";
  const tokenStr = tokens.length ? tokens.join(", ") : "(none detected)";
  const parts: string[] = [
    `Selected ${ranked.length} file(s) for task "${task}".`,
    `Detected tokens: ${tokenStr}.`,
    `Top match: ${topDesc}.`,
  ];
  if (wantsTests) {
    parts.push(
      "Task mentions testing/fixing — test files near matches were boosted.",
    );
  }
  parts.push(
    `Scoring: name match (0.25-0.5) + extension (0.02-0.05) + recency (<=0.1) + test association (<=0.2) + directory proximity (0.08).`,
  );
  return parts.join(" ");
}

/**
 * Format a symbol as a compact signature string for the context package outline.
 * Example: "function login(user: string, pass: string): Promise<AuthResult>"
 */
function formatSymbolSignature(sym: {
  name: string;
  kind: string;
  params: string[];
  exported: boolean;
}): string {
  const prefix = sym.exported ? "export " : "";
  const params = sym.params.length > 0 ? `(${sym.params.join(", ")})` : "()";
  return `${prefix}${sym.kind} ${sym.name}${params}`;
}

/**
 * Graph query engine — structural queries over the code index.
 *
 * Queries:
 *   - callers(name)     → who calls this function?
 *   - callees(name)     → what does this function call?
 *   - impact(filePath)  → what files/functions might be affected by changes?
 *   - architecture()    → project overview: packages, entry points, hotspots
 *   - search(query)     → find symbols by name pattern
 *   - deadCode()        → functions with zero callers
 *
 * All queries return compact, token-efficient output — the whole point is
 * replacing dozens of grep/read cycles with one structural query.
 */
import type { SqliteStore } from "../store/sqlite.js";
import { relative, basename, dirname, join } from "node:path";

export interface SymbolResult {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  async: boolean;
  params: string[];
  className: string | null;
}

export interface CallResult {
  callerName: string;
  calleeName: string;
  filePath: string;
  line: number;
  /** The symbol definition of the callee (if found). */
  calleeSymbol?: SymbolResult;
}

export interface ImpactResult {
  /** Files that import the changed file. */
  directDependents: string[];
  /** Functions that call functions defined in the changed file. */
  affectedCallers: CallResult[];
  /** Functions defined in the changed file (that could change behavior). */
  affectedSymbols: SymbolResult[];
  /** Files transitively affected (2 hops). */
  transitiveDependents: string[];
  /** Risk level: low (few dependents) / medium / high (many dependents). */
  risk: "low" | "medium" | "high";
}

export interface ArchitectureResult {
  /** Languages detected with file counts. */
  languages: { language: string; fileCount: number }[];
  /** Top-level packages/directories. */
  packages: { name: string; fileCount: number; symbolCount: number }[];
  /** Entry points (exported functions, main files). */
  entryPoints: SymbolResult[];
  /** Hotspot files (most symbols or most callers). */
  hotspots: { filePath: string; symbolCount: number; callerCount: number }[];
  /** Total counts. */
  totalFiles: number;
  totalSymbols: number;
  totalCalls: number;
  totalImports: number;
}

export class GraphQuery {
  constructor(
    private store: SqliteStore,
    private repoRoot: string,
  ) {}

  /**
   * True if no files have been indexed for this project yet. Code-intelligence
   * tools use this to return a helpful "run warden_index first" hint instead
   * of silently returning empty results (which confuses the agent/user).
   */
  isEmpty(): boolean {
    const row = this.store.db
      .prepare("SELECT COUNT(*) AS n FROM index_files WHERE project = ?")
      .get(this.repoRoot) as { n: number } | undefined;
    return (row?.n ?? 0) === 0;
  }

  /**
   * Find all callers of a function — who calls `name`?
   * Returns call sites and the files they're in.
   */
  callers(name: string, limit = 50): CallResult[] {
    // Search by exact name or qualified name (Class.method)
    const rows = this.store.db
      .prepare(
        `SELECT c.caller_name, c.callee_name, c.file_path, c.line,
                s.name as sym_name, s.kind, s.start_line, s.end_line,
                s.exported, s.is_async, s.params_json, s.class_name,
                s.file_path as sym_file
         FROM index_calls c
         LEFT JOIN index_symbols s ON s.project = c.project
           AND s.name = c.callee_name AND s.file_path != c.file_path
         WHERE c.project = ? AND c.callee_name = ?
         LIMIT ?`,
      )
      .all(this.repoRoot, name, limit) as any[];

    return rows.map((r) => ({
      callerName: r.caller_name as string,
      calleeName: r.callee_name as string,
      filePath: r.file_path as string,
      line: r.line as number,
      calleeSymbol: r.sym_name
        ? {
            name: r.sym_name,
            kind: r.kind,
            filePath: r.sym_file,
            startLine: r.start_line,
            endLine: r.end_line,
            exported: !!r.exported,
            async: !!r.is_async,
            params: JSON.parse(r.params_json ?? "[]"),
            className: r.class_name,
          }
        : undefined,
    }));
  }

  /**
   * Find all callees of a function — what does `name` call?
   * Returns the functions called and where they're defined (if found).
   */
  callees(name: string, limit = 50): CallResult[] {
    // Match exact name or Class.method
    const patterns = [name, name.split(".").pop()!];
    const placeholders = patterns.map(() => "?").join(",");
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT c.caller_name, c.callee_name, c.file_path, c.line,
                s.name as sym_name, s.kind, s.start_line, s.end_line,
                s.exported, s.is_async, s.params_json, s.class_name,
                s.file_path as sym_file
         FROM index_calls c
         LEFT JOIN index_symbols s ON s.project = c.project AND s.name = c.callee_name
         WHERE c.project = ? AND c.caller_name IN (${placeholders})
         LIMIT ?`,
      )
      .all(this.repoRoot, ...patterns, limit) as any[];

    return rows.map((r) => ({
      callerName: r.caller_name as string,
      calleeName: r.callee_name as string,
      filePath: r.file_path as string,
      line: r.line as number,
      calleeSymbol: r.sym_name
        ? {
            name: r.sym_name,
            kind: r.kind,
            filePath: r.sym_file,
            startLine: r.start_line,
            endLine: r.end_line,
            exported: !!r.exported,
            async: !!r.is_async,
            params: JSON.parse(r.params_json ?? "[]"),
            className: r.class_name,
          }
        : undefined,
    }));
  }

  /**
   * Impact analysis — what's affected by changes to a file?
   * Traces: file → its symbols → their callers → callers' files.
   */
  impact(filePath: string): ImpactResult {
    const relPath = relative(this.repoRoot, filePath);

    // Symbols defined in the changed file
    const affectedSymbols = this.symbolsInFile(relPath);

    // Files that import the changed file
    const directDependents = this.filesImporting(relPath);

    // Functions that call functions defined in the changed file
    const symbolNames = new Set(affectedSymbols.map((s) => s.name));
    const affectedCallers: CallResult[] = [];
    for (const name of symbolNames) {
      const callers = this.callers(name);
      affectedCallers.push(...callers);
    }

    // Transitive dependents (2 hops): files that import the direct dependents
    const transitiveSet = new Set<string>();
    for (const dep of directDependents) {
      const transitive = this.filesImporting(dep);
      for (const t of transitive) {
        if (t !== relPath && !directDependents.includes(t)) {
          transitiveSet.add(t);
        }
      }
    }

    // Risk assessment
    const totalDependents = directDependents.length + transitiveSet.size;
    const totalCallers = affectedCallers.length;
    const risk: "low" | "medium" | "high" =
      totalDependents > 10 || totalCallers > 20
        ? "high"
        : totalDependents > 3 || totalCallers > 5
          ? "medium"
          : "low";

    return {
      directDependents,
      affectedCallers: affectedCallers.slice(0, 50),
      affectedSymbols,
      transitiveDependents: [...transitiveSet].slice(0, 20),
      risk,
    };
  }

  /**
   * Architecture overview — one call returns the project's structure.
   * Languages, packages, entry points, hotspots.
   */
  architecture(): ArchitectureResult {
    // Languages
    const fileRows = this.store.db
      .prepare("SELECT rel_path FROM index_files WHERE project = ?")
      .all(this.repoRoot) as { rel_path: string }[];
    const langMap = new Map<string, number>();
    for (const f of fileRows) {
      const ext = f.rel_path.split(".").pop() ?? "unknown";
      const lang =
        ext === "ts" || ext === "tsx"
          ? "TypeScript"
          : ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs"
            ? "JavaScript"
            : ext === "py"
              ? "Python"
              : ext;
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
    const languages = [...langMap.entries()]
      .map(([language, fileCount]) => ({ language, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount);

    // Packages (top-level directories)
    const packageMap = new Map<
      string,
      { fileCount: number; symbolCount: number }
    >();
    for (const f of fileRows) {
      const parts = f.rel_path.split("/");
      const pkg = parts.length > 1 ? parts[0]! : "(root)";
      const existing = packageMap.get(pkg) ?? { fileCount: 0, symbolCount: 0 };
      existing.fileCount++;
      packageMap.set(pkg, existing);
    }
    // Add symbol counts per package
    const symRows = this.store.db
      .prepare("SELECT file_path FROM index_symbols WHERE project = ?")
      .all(this.repoRoot) as { file_path: string }[];
    for (const s of symRows) {
      const parts = s.file_path.split("/");
      const pkg = parts.length > 1 ? parts[0]! : "(root)";
      const existing = packageMap.get(pkg);
      if (existing) existing.symbolCount++;
    }
    const packages = [...packageMap.entries()]
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.symbolCount - a.symbolCount)
      .slice(0, 15);

    // Entry points (exported functions)
    const entryRows = this.store.db
      .prepare(
        `SELECT name, kind, file_path, start_line, end_line, exported, is_async, params_json, class_name
         FROM index_symbols
         WHERE project = ? AND exported = 1 AND kind IN ('function', 'class')
         ORDER BY name
         LIMIT 30`,
      )
      .all(this.repoRoot) as any[];
    const entryPoints: SymbolResult[] = entryRows.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      exported: !!r.exported,
      async: !!r.is_async,
      params: JSON.parse(r.params_json ?? "[]"),
      className: r.class_name,
    }));

    // Hotspots (files with most symbols and callers)
    const hotspotRows = this.store.db
      .prepare(
        `SELECT rel_path, symbol_count,
                (SELECT COUNT(*) FROM index_calls c2
                 WHERE c2.project = index_files.project
                   AND c2.callee_name IN (
                     SELECT name FROM index_symbols s2
                     WHERE s2.project = index_files.project
                       AND s2.file_path = index_files.rel_path
                   )) AS caller_count
         FROM index_files
         WHERE project = ?
         ORDER BY caller_count DESC, symbol_count DESC
         LIMIT 10`,
      )
      .all(this.repoRoot) as {
      rel_path: string;
      symbol_count: number;
      caller_count: number;
    }[];
    const hotspots = hotspotRows.map((r) => ({
      filePath: r.rel_path,
      symbolCount: r.symbol_count,
      callerCount: r.caller_count,
    }));

    // Totals
    const stats = this.store.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM index_files WHERE project = ?) AS files,
           (SELECT COUNT(*) FROM index_symbols WHERE project = ?) AS symbols,
           (SELECT COUNT(*) FROM index_calls WHERE project = ?) AS calls,
           (SELECT COUNT(*) FROM index_imports WHERE project = ?) AS imports`,
      )
      .get(this.repoRoot, this.repoRoot, this.repoRoot, this.repoRoot) as any;

    return {
      languages,
      packages,
      entryPoints,
      hotspots,
      totalFiles: stats?.files ?? 0,
      totalSymbols: stats?.symbols ?? 0,
      totalCalls: stats?.calls ?? 0,
      totalImports: stats?.imports ?? 0,
    };
  }

  /**
   * Search for symbols by name pattern.
   */
  search(query: string, limit = 30): SymbolResult[] {
    const pattern = `%${query}%`;
    const rows = this.store.db
      .prepare(
        `SELECT name, kind, file_path, start_line, end_line, exported, is_async, params_json, class_name
         FROM index_symbols
         WHERE project = ? AND name LIKE ?
         ORDER BY exported DESC, name
         LIMIT ?`,
      )
      .all(this.repoRoot, pattern, limit) as any[];
    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      exported: !!r.exported,
      async: !!r.is_async,
      params: JSON.parse(r.params_json ?? "[]"),
      className: r.class_name,
    }));
  }

  /**
   * Dead code detection — exported functions with zero callers.
   * (Non-exported functions with zero callers are also dead, but we focus
   * on exported ones first since they're more likely to be intentionally
   * unused API surface.)
   */
  deadCode(limit = 30): SymbolResult[] {
    const rows = this.store.db
      .prepare(
        `SELECT s.name, s.kind, s.file_path, s.start_line, s.end_line,
                s.exported, s.is_async, s.params_json, s.class_name
         FROM index_symbols s
         WHERE s.project = ? AND s.kind IN ('function', 'method')
           AND NOT EXISTS (
             SELECT 1 FROM index_calls c
             WHERE c.project = s.project AND c.callee_name = s.name
           )
         ORDER BY s.file_path, s.start_line
         LIMIT ?`,
      )
      .all(this.repoRoot, limit) as any[];
    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      exported: !!r.exported,
      async: !!r.is_async,
      params: JSON.parse(r.params_json ?? "[]"),
      className: r.class_name,
    }));
  }

  // --- Helpers ---

  private symbolsInFile(relPath: string): SymbolResult[] {
    const rows = this.store.db
      .prepare(
        `SELECT name, kind, file_path, start_line, end_line, exported, is_async, params_json, class_name
         FROM index_symbols WHERE project = ? AND file_path = ?`,
      )
      .all(this.repoRoot, relPath) as any[];
    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      exported: !!r.exported,
      async: !!r.is_async,
      params: JSON.parse(r.params_json ?? "[]"),
      className: r.class_name,
    }));
  }

  private filesImporting(relPath: string): string[] {
    // Files that import from this file (by resolved_path or from_module matching)
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT file_path FROM index_imports
         WHERE project = ? AND (resolved_path = ? OR from_module LIKE ?)`,
      )
      .all(this.repoRoot, relPath, `%${relPath.replace(/\.\w+$/, "")}%`) as {
      file_path: string;
    }[];
    return rows.map((r) => r.file_path);
  }
}

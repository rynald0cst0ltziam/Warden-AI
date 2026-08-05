/**
 * Code indexer — walks the project tree, parses each file, stores symbols,
 * imports, and calls in the SQLite database.
 *
 * Indexing is incremental: only files that changed (by mtime) are re-parsed.
 * The index is stored per-project (identified by repoRoot).
 */
import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  parseFile,
  isSupported,
  initParser,
  preloadLanguages,
  getSupportedExtensions,
  type ParseResult,
  type SymbolDef,
  type ImportDef,
  type CallDef,
} from "./parser.js";
import type { SqliteStore } from "../store/sqlite.js";
import { logger } from "../logging/index.js";

export interface IndexResult {
  filesScanned: number;
  filesParsed: number;
  symbolsFound: number;
  importsFound: number;
  callsFound: number;
  durationMs: number;
  skipped: string[];
}

/** Directories to skip during indexing. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".warden",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "venv",
  ".venv",
  "env",
  ".env",
  "coverage",
  ".nyc_output",
  "tmp",
  "temp",
  ".cache",
  ".turbo",
  ".output",
  ".svelte-kit",
  "target",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  "vendor",
  "Pods",
]);

/** File extensions we index — all languages supported by tree-sitter. */
const INDEX_EXTENSIONS = new Set(getSupportedExtensions());

export interface IndexOptions {
  /** Root directory to index. */
  repoRoot: string;
  /** Maximum files to index (safety cap). */
  maxFiles?: number;
  /** Force full re-index (ignore mtime). */
  force?: boolean;
}

export class CodeIndex {
  constructor(private store: SqliteStore) {}

  /**
   * Index a project. Walks the tree, parses changed files, stores results.
   * Incremental: only files newer than their last index time are re-parsed.
   * Initializes tree-sitter WASM parser on first call.
   */
  async index(opts: IndexOptions): Promise<IndexResult> {
    // Initialize parser and preload languages
    await initParser();

    const start = Date.now();
    const repoRoot = resolve(opts.repoRoot);
    const maxFiles = opts.maxFiles ?? 10000;
    const force = opts.force ?? false;

    // Discover files
    const files = this.discoverFiles(repoRoot, maxFiles);
    const skipped: string[] = [];

    // Preload tree-sitter languages for all file extensions found
    const extensions = new Set<string>();
    for (const f of files) {
      extensions.add(extname(f).toLowerCase());
    }
    if (extensions.size > 0) {
      await preloadLanguages(Array.from(extensions));
    }

    let filesParsed = 0;
    let symbolsFound = 0;
    let importsFound = 0;
    let callsFound = 0;

    // Clear existing index for this project if force
    if (force) {
      this.clearProject(repoRoot);
    }

    // Get last-indexed mtimes for incremental
    const knownMtimes = force
      ? new Map<string, number>()
      : this.getIndexedMtimes(repoRoot);

    for (const filePath of files) {
      try {
        const stat = statSync(filePath);
        const mtime = stat.mtimeMs;
        const relPath = relative(repoRoot, filePath);

        // Skip if unchanged
        if (knownMtimes.get(relPath) === mtime) continue;

        // Parse the file
        const result: ParseResult = parseFile(filePath);

        // Delete old data for this file, then insert new
        this.deleteFileData(repoRoot, relPath);
        this.storeFileData(repoRoot, relPath, filePath, result, mtime);

        filesParsed++;
        symbolsFound += result.symbols.length;
        importsFound += result.imports.length;
        callsFound += result.calls.length;
      } catch (err) {
        skipped.push(`${relative(repoRoot, filePath)}: ${String(err)}`);
      }
    }

    // Clean up files that no longer exist
    this.pruneDeletedFiles(repoRoot, files);

    const durationMs = Date.now() - start;
    const result: IndexResult = {
      filesScanned: files.length,
      filesParsed,
      symbolsFound,
      importsFound,
      callsFound,
      durationMs,
      skipped,
    };
    logger.info("code index complete", {
      repoRoot,
      filesParsed,
      symbolsFound,
      durationMs,
    });
    return result;
  }

  /** Walk the project tree and return supported source files. */
  private discoverFiles(repoRoot: string, maxFiles: number): string[] {
    const files: string[] = [];
    const queue: string[] = [repoRoot];

    while (queue.length > 0 && files.length < maxFiles) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        const fullPath = join(dir, entry);
        let stat;
        try {
          // lstat (not stat) so we can detect and skip symlinks — a symlink that
          // points at a parent directory would otherwise cause infinite traversal.
          stat = lstatSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(entry) && !entry.startsWith(".")) {
            queue.push(fullPath);
          }
        } else if (
          stat.isFile() &&
          INDEX_EXTENSIONS.has(extname(entry).toLowerCase())
        ) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  /** Get mtimes of already-indexed files for incremental updates. */
  private getIndexedMtimes(repoRoot: string): Map<string, number> {
    const rows = this.store.db
      .prepare("SELECT rel_path, mtime FROM index_files WHERE project = ?")
      .all(repoRoot) as { rel_path: string; mtime: number }[];
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.rel_path, r.mtime);
    return map;
  }

  /** Delete all index data for a project. */
  clearProject(repoRoot: string): void {
    this.store.db
      .prepare("DELETE FROM index_symbols WHERE project = ?")
      .run(repoRoot);
    this.store.db
      .prepare("DELETE FROM index_imports WHERE project = ?")
      .run(repoRoot);
    this.store.db
      .prepare("DELETE FROM index_calls WHERE project = ?")
      .run(repoRoot);
    this.store.db
      .prepare("DELETE FROM index_files WHERE project = ?")
      .run(repoRoot);
  }

  /** Delete index data for a single file. */
  private deleteFileData(repoRoot: string, relPath: string): void {
    this.store.db
      .prepare("DELETE FROM index_symbols WHERE project = ? AND file_path = ?")
      .run(repoRoot, relPath);
    this.store.db
      .prepare("DELETE FROM index_imports WHERE project = ? AND file_path = ?")
      .run(repoRoot, relPath);
    this.store.db
      .prepare("DELETE FROM index_calls WHERE project = ? AND file_path = ?")
      .run(repoRoot, relPath);
    this.store.db
      .prepare("DELETE FROM index_files WHERE project = ? AND rel_path = ?")
      .run(repoRoot, relPath);
  }

  /** Store parsed data for a file. */
  private storeFileData(
    repoRoot: string,
    relPath: string,
    absPath: string,
    result: ParseResult,
    mtime: number,
  ): void {
    // Record the file
    this.store.db
      .prepare(
        "INSERT OR REPLACE INTO index_files (project, rel_path, abs_path, mtime, symbol_count) VALUES (?,?,?,?,?)",
      )
      .run(repoRoot, relPath, absPath, mtime, result.symbols.length);

    // Insert symbols
    const symStmt = this.store.db.prepare(
      `INSERT INTO index_symbols (project, file_path, name, kind, start_line, end_line, exported, is_async, params_json, class_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const sym of result.symbols) {
      symStmt.run(
        repoRoot,
        relPath,
        sym.name,
        sym.kind,
        sym.startLine,
        sym.endLine,
        sym.exported ? 1 : 0,
        sym.async ? 1 : 0,
        JSON.stringify(sym.params),
        sym.className ?? null,
      );
    }

    // Insert imports
    const impStmt = this.store.db.prepare(
      `INSERT INTO index_imports (project, file_path, line, names_json, from_module, resolved_path)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const imp of result.imports) {
      const impRelPath = imp.resolvedPath
        ? relative(repoRoot, imp.resolvedPath)
        : null;
      impStmt.run(
        repoRoot,
        relPath,
        imp.line,
        JSON.stringify(imp.names),
        imp.from,
        impRelPath,
      );
    }

    // Insert calls
    const callStmt = this.store.db.prepare(
      `INSERT INTO index_calls (project, file_path, line, caller_name, callee_name)
       VALUES (?,?,?,?,?)`,
    );
    for (const call of result.calls) {
      callStmt.run(
        repoRoot,
        relPath,
        call.line,
        call.callerName,
        call.calleeName,
      );
    }
  }

  /** Remove index entries for files that no longer exist. */
  private pruneDeletedFiles(repoRoot: string, currentFiles: string[]): void {
    const currentRelPaths = new Set(
      currentFiles.map((f) => relative(repoRoot, f)),
    );
    const indexedRows = this.store.db
      .prepare("SELECT rel_path FROM index_files WHERE project = ?")
      .all(repoRoot) as { rel_path: string }[];
    for (const row of indexedRows) {
      if (!currentRelPaths.has(row.rel_path)) {
        this.deleteFileData(repoRoot, row.rel_path);
      }
    }
  }

  /** Check if a project has been indexed. */
  isIndexed(repoRoot: string): boolean {
    const row = this.store.db
      .prepare("SELECT COUNT(*) AS c FROM index_files WHERE project = ?")
      .get(repoRoot) as { c: number } | undefined;
    return (row?.c ?? 0) > 0;
  }

  /** Get index stats for a project. */
  indexStats(repoRoot: string): {
    files: number;
    symbols: number;
    imports: number;
    calls: number;
  } {
    const files = this.store.db
      .prepare("SELECT COUNT(*) AS c FROM index_files WHERE project = ?")
      .get(repoRoot) as { c: number };
    const symbols = this.store.db
      .prepare("SELECT COUNT(*) AS c FROM index_symbols WHERE project = ?")
      .get(repoRoot) as { c: number };
    const imports = this.store.db
      .prepare("SELECT COUNT(*) AS c FROM index_imports WHERE project = ?")
      .get(repoRoot) as { c: number };
    const calls = this.store.db
      .prepare("SELECT COUNT(*) AS c FROM index_calls WHERE project = ?")
      .get(repoRoot) as { c: number };
    return {
      files: files.c,
      symbols: symbols.c,
      imports: imports.c,
      calls: calls.c,
    };
  }
}

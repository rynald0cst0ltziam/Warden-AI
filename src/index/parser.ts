/**
 * Code parser — tree-sitter-based extraction of symbols, imports, and call sites.
 *
 * Uses web-tree-sitter (WASM) for production-quality AST parsing across 30+
 * languages. No native compilation needed — works on Windows, macOS, Linux.
 *
 * What we extract:
 *   - Symbols: functions, methods, classes, interfaces, types, enums
 *     (name, kind, file, start line, end line, exported, params)
 *   - Imports: what's imported, from where, resolved to a file if possible
 *   - Calls: which function calls which (caller name, callee name, line)
 *
 * Supported languages (via tree-sitter WASM grammars):
 *   TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP,
 *   Bash, CSS, HTML, JSON, YAML, Swift, Kotlin, Scala, Lua, Dart, Elixir,
 *   Zig, OCaml, Elm, Rescript, Vue, Solidity, Objective-C, TOML, and more.
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, extname, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// web-tree-sitter Parser class (loaded async)
let ParserClass: any = null;
let initialized = false;
const languageCache = new Map<string, any>();

/** Path to the WASM grammar files. */
let WASM_DIR = "";

function findWasmDir(): string {
  // Try multiple locations for the WASM files.
  // IMPORTANT: Check package-relative paths FIRST, then cwd-relative.
  // When warden is installed globally, the WASM files live in warden's
  // node_modules, not the user's project node_modules.
  const candidates = [
    join(__dirname, "..", "..", "node_modules", "tree-sitter-wasms", "out"),
    join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out"),
    join(process.cwd(), "node_modules", "tree-sitter-wasms", "out"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: search up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "node_modules", "tree-sitter-wasms", "out");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(__dirname, "..", "..", "node_modules", "tree-sitter-wasms", "out");
}

/**
 * Initialize the parser — must be called before parseFile().
 * Loads the web-tree-sitter WASM runtime.
 */
export async function initParser(): Promise<void> {
  if (initialized) return;

  // web-tree-sitter v0.22.x exports the Parser class as the default export
  // In ESM, we need to use createRequire for CJS modules
  const mod = await import("web-tree-sitter");
  ParserClass = mod.default ?? mod;

  // Find the web-tree-sitter core WASM file
  const coreWasmDir = findCoreWasmDir();

  // Parser.init() is a static method that loads the WASM runtime
  await ParserClass.init({
    locateFile: (filename: string) => join(coreWasmDir, filename),
  });

  WASM_DIR = findWasmDir();
  initialized = true;
}

/** Find the directory containing tree-sitter.wasm (the core runtime WASM) */
function findCoreWasmDir(): string {
  // IMPORTANT: Check package-relative paths FIRST, then cwd-relative.
  // When warden is installed globally, the WASM runtime lives in warden's
  // node_modules, not the user's project node_modules.
  const candidates = [
    join(__dirname, "..", "..", "node_modules", "web-tree-sitter"),
    join(__dirname, "..", "node_modules", "web-tree-sitter"),
    join(process.cwd(), "node_modules", "web-tree-sitter"),
    join(process.cwd(), "..", "node_modules", "web-tree-sitter"),
  ];
  // Check by looking for tree-sitter.wasm (v0.22) or web-tree-sitter.wasm (v0.25+)
  for (const c of candidates) {
    if (existsSync(join(c, "tree-sitter.wasm"))) return c;
    if (existsSync(join(c, "web-tree-sitter.wasm"))) return c;
  }
  // Search up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "node_modules", "web-tree-sitter");
    if (existsSync(join(candidate, "tree-sitter.wasm"))) return candidate;
    if (existsSync(join(candidate, "web-tree-sitter.wasm"))) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(__dirname, "..", "..", "node_modules", "web-tree-sitter");
}

/** Check if the parser is initialized. */
export function isParserInitialized(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Types (same interface as before)
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  async: boolean;
  params: string[];
  className?: string;
}

export interface ImportDef {
  filePath: string;
  names: string[];
  from: string;
  resolvedPath?: string;
  line: number;
}

export interface CallDef {
  filePath: string;
  callerName: string;
  calleeName: string;
  line: number;
}

export interface ParseResult {
  symbols: SymbolDef[];
  imports: ImportDef[];
  calls: CallDef[];
}

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

interface LanguageConfig {
  wasmFile: string;
  /** Node types that represent function declarations. */
  functionNodes: string[];
  /** Node types that represent method declarations. */
  methodNodes: string[];
  /** Node types that represent class declarations. */
  classNodes: string[];
  /** Node types that represent interface declarations. */
  interfaceNodes: string[];
  /** Node types that represent type alias declarations. */
  typeNodes: string[];
  /** Node types that represent enum declarations. */
  enumNodes: string[];
  /** Node types that represent import statements. */
  importNodes: string[];
  /** Node types that represent call expressions. */
  callNodes: string[];
  /** Node type for the "name" field of a declaration. */
  nameField?: string;
  /** Node type for the "parameters" field. */
  paramsField?: string;
  /** Whether this language uses `async` keyword. */
  hasAsync: boolean;
  /** Whether this language uses `export` keyword. */
  hasExport: boolean;
  /** Function to extract import names from an import node. */
  extractImport?: ((node: any, filePath: string) => ImportDef | null) | null;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {};

// --- TypeScript / JavaScript ---
const TS_JS_CONFIG: LanguageConfig = {
  wasmFile: "tree-sitter-typescript.wasm",
  functionNodes: ["function_declaration", "lexical_declaration", "variable_declaration"],
  methodNodes: ["method_definition"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: ["type_alias_declaration"],
  enumNodes: ["enum_declaration"],
  importNodes: ["import_statement"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: true,
  hasExport: true,
  extractImport: extractTsImport,
};

LANGUAGE_CONFIGS[".ts"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-typescript.wasm", callNodes: ["call_expression", "new_expression"] };
LANGUAGE_CONFIGS[".tsx"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-tsx.wasm", callNodes: ["call_expression", "new_expression"] };
LANGUAGE_CONFIGS[".js"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-javascript.wasm", callNodes: ["call_expression", "new_expression"] };
LANGUAGE_CONFIGS[".jsx"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-javascript.wasm", callNodes: ["call_expression", "new_expression"] };
LANGUAGE_CONFIGS[".mjs"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-javascript.wasm", callNodes: ["call_expression", "new_expression"] };
LANGUAGE_CONFIGS[".cjs"] = { ...TS_JS_CONFIG, wasmFile: "tree-sitter-javascript.wasm", callNodes: ["call_expression", "new_expression"] };

// --- Python ---
LANGUAGE_CONFIGS[".py"] = {
  wasmFile: "tree-sitter-python.wasm",
  functionNodes: ["function_definition"],
  methodNodes: ["function_definition"], // Python doesn't distinguish — we detect via class context
  classNodes: ["class_definition"],
  interfaceNodes: [], // Python has no interfaces
  typeNodes: [], // Python type aliases are assignments
  enumNodes: [], // Python enums are class assignments
  importNodes: ["import_statement", "import_from_statement"],
  callNodes: ["call"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: true,
  hasExport: false,
  extractImport: extractPythonImport,
};

// --- Go ---
LANGUAGE_CONFIGS[".go"] = {
  wasmFile: "tree-sitter-go.wasm",
  functionNodes: ["function_declaration", "method_declaration"],
  methodNodes: ["method_declaration"],
  classNodes: [], // Go has no classes — structs are type declarations
  interfaceNodes: ["interface_type"],
  typeNodes: ["type_declaration"],
  enumNodes: [], // Go has no enums — iota consts
  importNodes: ["import_declaration"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: false,
  hasExport: true, // Go exports by capitalization
  extractImport: extractGoImport,
};

// --- Rust ---
LANGUAGE_CONFIGS[".rs"] = {
  wasmFile: "tree-sitter-rust.wasm",
  functionNodes: ["function_item"],
  methodNodes: ["function_item"], // detected via impl context
  classNodes: ["struct_item", "trait_item"],
  interfaceNodes: ["trait_item"],
  typeNodes: ["type_item"],
  enumNodes: ["enum_item"],
  importNodes: ["use_declaration"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: true,
  hasExport: true, // Rust exports by pub
  extractImport: extractRustImport,
};

// --- Java ---
LANGUAGE_CONFIGS[".java"] = {
  wasmFile: "tree-sitter-java.wasm",
  functionNodes: ["method_declaration", "constructor_declaration"],
  methodNodes: ["method_declaration"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: [], // Java has no type aliases
  enumNodes: ["enum_declaration"],
  importNodes: ["import_declaration"],
  callNodes: ["method_invocation"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: false,
  hasExport: true, // Java exports by public
  extractImport: extractJavaImport,
};

// --- C ---
LANGUAGE_CONFIGS[".c"] = {
  wasmFile: "tree-sitter-c.wasm",
  functionNodes: ["function_definition", "declaration"],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: ["type_definition"],
  enumNodes: ["enum_specifier"],
  importNodes: ["preproc_include"],
  callNodes: ["call_expression"],
  nameField: "declarator",
  paramsField: "parameter_declaration",
  hasAsync: false,
  hasExport: false,
  extractImport: extractCImport,
};
LANGUAGE_CONFIGS[".h"] = { ...LANGUAGE_CONFIGS[".c"]! };

// --- C++ ---
LANGUAGE_CONFIGS[".cpp"] = {
  ...LANGUAGE_CONFIGS[".c"],
  wasmFile: "tree-sitter-cpp.wasm",
  classNodes: ["class_specifier", "struct_specifier"],
  methodNodes: ["function_definition", "function_declaration"],
  functionNodes: ["function_definition", "function_declaration"],
};
LANGUAGE_CONFIGS[".cc"] = { ...LANGUAGE_CONFIGS[".cpp"]! };
LANGUAGE_CONFIGS[".cxx"] = { ...LANGUAGE_CONFIGS[".cpp"]! };
LANGUAGE_CONFIGS[".hpp"] = { ...LANGUAGE_CONFIGS[".cpp"]! };

// --- C# ---
LANGUAGE_CONFIGS[".cs"] = {
  wasmFile: "tree-sitter-c_sharp.wasm",
  functionNodes: ["method_declaration", "constructor_declaration"],
  methodNodes: ["method_declaration"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: [], // C# doesn't have type aliases in the same way
  enumNodes: ["enum_declaration"],
  importNodes: ["using_directive"],
  callNodes: ["invocation_expression"],
  nameField: "name",
  paramsField: "parameter_list",
  hasAsync: true,
  hasExport: true,
  extractImport: extractCSharpImport,
};

// --- Ruby ---
LANGUAGE_CONFIGS[".rb"] = {
  wasmFile: "tree-sitter-ruby.wasm",
  functionNodes: ["method", "singleton_method"],
  methodNodes: ["method"],
  classNodes: ["class", "module"],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: ["call"], // Ruby uses require/require_relative — detected by content
  callNodes: ["call"],
  nameField: "name",
  paramsField: "method_parameters",
  hasAsync: false,
  hasExport: false,
  extractImport: extractRubyImport,
};

// --- PHP ---
LANGUAGE_CONFIGS[".php"] = {
  wasmFile: "tree-sitter-php.wasm",
  functionNodes: ["function_definition", "method_declaration"],
  methodNodes: ["method_declaration"],
  classNodes: ["class_declaration", "interface_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: [],
  enumNodes: ["enum_declaration"],
  importNodes: ["use_declaration"],
  callNodes: ["function_call_expression", "method_call_expression"],
  nameField: "name",
  paramsField: "formal_parameters",
  hasAsync: false,
  hasExport: true,
  extractImport: extractPhpImport,
};

// --- Bash ---
LANGUAGE_CONFIGS[".sh"] = {
  wasmFile: "tree-sitter-bash.wasm",
  functionNodes: ["function_definition"],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: ["source_command"],
  callNodes: ["command"],
  nameField: "name",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};
LANGUAGE_CONFIGS[".bash"] = { ...LANGUAGE_CONFIGS[".sh"]! };

// --- CSS ---
LANGUAGE_CONFIGS[".css"] = {
  wasmFile: "tree-sitter-css.wasm",
  functionNodes: [],
  methodNodes: [],
  classNodes: ["rule_set"],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: ["import_statement"],
  callNodes: [],
  nameField: "selectors",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};

// --- HTML ---
LANGUAGE_CONFIGS[".html"] = {
  wasmFile: "tree-sitter-html.wasm",
  functionNodes: [],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: [],
  callNodes: [],
  nameField: "",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};

// --- JSON ---
LANGUAGE_CONFIGS[".json"] = {
  wasmFile: "tree-sitter-json.wasm",
  functionNodes: [],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: [],
  callNodes: [],
  nameField: "",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};

// --- YAML ---
LANGUAGE_CONFIGS[".yaml"] = {
  wasmFile: "tree-sitter-yaml.wasm",
  functionNodes: [],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: [],
  callNodes: [],
  nameField: "",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};
LANGUAGE_CONFIGS[".yml"] = { ...LANGUAGE_CONFIGS[".yaml"]! };

// --- Swift ---
LANGUAGE_CONFIGS[".swift"] = {
  wasmFile: "tree-sitter-swift.wasm",
  functionNodes: ["function_declaration"],
  methodNodes: ["function_declaration"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["protocol_declaration"],
  typeNodes: ["type_alias_declaration"],
  enumNodes: ["enum_declaration"],
  importNodes: ["import_declaration"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameter_list",
  hasAsync: true,
  hasExport: false,
  extractImport: extractSwiftImport,
};

// --- Kotlin ---
LANGUAGE_CONFIGS[".kt"] = {
  wasmFile: "tree-sitter-kotlin.wasm",
  functionNodes: ["function_declaration"],
  methodNodes: ["function_declaration"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: ["type_alias"],
  enumNodes: ["enum_declaration"],
  importNodes: ["import_list", "import_header"],
  callNodes: ["call_expression"],
  nameField: "simple_identifier",
  paramsField: "function_value_parameters",
  hasAsync: false,
  hasExport: false,
  extractImport: extractKotlinImport,
};
LANGUAGE_CONFIGS[".kts"] = { ...LANGUAGE_CONFIGS[".kt"]! };

// --- Scala ---
LANGUAGE_CONFIGS[".scala"] = {
  wasmFile: "tree-sitter-scala.wasm",
  functionNodes: ["function_definition"],
  methodNodes: ["function_definition"],
  classNodes: ["class_definition", "object_definition"],
  interfaceNodes: ["trait_definition"],
  typeNodes: ["type_definition"],
  enumNodes: [],
  importNodes: ["import_declaration"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: false,
  hasExport: false,
  extractImport: extractScalaImport,
};

// --- Lua ---
LANGUAGE_CONFIGS[".lua"] = {
  wasmFile: "tree-sitter-lua.wasm",
  functionNodes: ["function_declaration", "function_definition"],
  methodNodes: ["function_definition"],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: ["function_call"], // require() calls
  callNodes: ["function_call"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: false,
  hasExport: false,
  extractImport: extractLuaImport,
};

// --- Dart ---
LANGUAGE_CONFIGS[".dart"] = {
  wasmFile: "tree-sitter-dart.wasm",
  functionNodes: ["function_signature", "method_signature"],
  methodNodes: ["method_signature"],
  classNodes: ["class_definition"],
  interfaceNodes: [], // Dart interfaces are abstract classes
  typeNodes: ["type_alias"],
  enumNodes: ["enum_declaration"],
  importNodes: ["import_or_export"],
  callNodes: ["call_expression", "method_call"],
  nameField: "name",
  paramsField: "formal_parameter_list",
  hasAsync: true,
  hasExport: true,
  extractImport: extractDartImport,
};

// --- Elixir ---
LANGUAGE_CONFIGS[".ex"] = {
  wasmFile: "tree-sitter-elixir.wasm",
  functionNodes: ["call"],
  methodNodes: ["call"],
  classNodes: ["call"],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: ["call"],
  callNodes: ["call"],
  nameField: "name",
  paramsField: "arguments",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};
LANGUAGE_CONFIGS[".exs"] = { ...LANGUAGE_CONFIGS[".ex"]! };

// --- Zig ---
LANGUAGE_CONFIGS[".zig"] = {
  wasmFile: "tree-sitter-zig.wasm",
  functionNodes: ["function_declaration"],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: ["type_declaration"],
  enumNodes: ["enum_declaration"],
  importNodes: ["builtin_function_call"], // @import
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: false,
  hasExport: true,
  extractImport: null,
};

// --- TOML ---
LANGUAGE_CONFIGS[".toml"] = {
  wasmFile: "tree-sitter-toml.wasm",
  functionNodes: [],
  methodNodes: [],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: [],
  enumNodes: [],
  importNodes: [],
  callNodes: [],
  nameField: "",
  paramsField: "",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};

// --- OCaml ---
LANGUAGE_CONFIGS[".ml"] = {
  wasmFile: "tree-sitter-ocaml.wasm",
  functionNodes: ["value_definition", "let_binding"],
  methodNodes: ["method_definition"],
  classNodes: ["class_definition"],
  interfaceNodes: [],
  typeNodes: ["type_definition"],
  enumNodes: [],
  importNodes: ["open_statement"],
  callNodes: ["application_expression"],
  nameField: "name",
  paramsField: "parameter_list",
  hasAsync: false,
  hasExport: false,
  extractImport: null,
};

// --- Vue ---
LANGUAGE_CONFIGS[".vue"] = {
  wasmFile: "tree-sitter-vue.wasm",
  functionNodes: ["function_declaration", "lexical_declaration", "variable_declaration"],
  methodNodes: ["method_definition"],
  classNodes: ["class_declaration"],
  interfaceNodes: ["interface_declaration"],
  typeNodes: ["type_alias_declaration"],
  enumNodes: ["enum_declaration"],
  importNodes: ["import_statement"],
  callNodes: ["call_expression"],
  nameField: "name",
  paramsField: "parameters",
  hasAsync: true,
  hasExport: true,
  extractImport: extractTsImport,
};

// ---------------------------------------------------------------------------
// Supported extensions
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANGUAGE_CONFIGS));

export function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** Get the list of all supported extensions. */
export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTENSIONS);
}

// ---------------------------------------------------------------------------
// Language loading
// ---------------------------------------------------------------------------

async function getLanguage(ext: string): Promise<any> {
  const config = LANGUAGE_CONFIGS[ext];
  if (!config) return null;

  if (languageCache.has(config.wasmFile)) {
    return languageCache.get(config.wasmFile);
  }

  const wasmPath = join(WASM_DIR, config.wasmFile);
  if (!existsSync(wasmPath)) {
    return null;
  }

  const lang = await ParserClass.Language.load(wasmPath);
  languageCache.set(config.wasmFile, lang);
  return lang;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a file and extract symbols, imports, and calls.
 * Must call initParser() before calling this.
 */
export function parseFile(filePath: string): ParseResult {
  if (!initialized) {
    // Fallback to empty result if not initialized
    return { symbols: [], imports: [], calls: [] };
  }

  const ext = extname(filePath).toLowerCase();
  const absPath = resolve(filePath);
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return { symbols: [], imports: [], calls: [] };
  }

  const config = LANGUAGE_CONFIGS[ext];
  if (!config) return { symbols: [], imports: [], calls: [] };

  // Get language (sync from cache, but may not be loaded yet)
  const lang = languageCache.get(config.wasmFile);
  if (!lang) return { symbols: [], imports: [], calls: [] };

  try {
    const parser = new ParserClass();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree) return { symbols: [], imports: [], calls: [] };

    const result = walkTree(tree.rootNode, absPath, content, config);
    tree.delete();
    parser.delete();
    return result;
  } catch {
    return { symbols: [], imports: [], calls: [] };
  }
}

/**
 * Parse a file asynchronously — loads the language if needed.
 * Use this when calling parseFile for the first time with a new extension.
 */
export async function parseFileAsync(filePath: string): Promise<ParseResult> {
  if (!initialized) {
    await initParser();
  }

  const ext = extname(filePath).toLowerCase();
  await getLanguage(ext);

  return parseFile(filePath);
}

/**
 * Pre-load all language grammars for the given file extensions.
 * Call this at startup to avoid lazy-loading delays.
 */
export async function preloadLanguages(extensions?: string[]): Promise<void> {
  if (!initialized) await initParser();
  const exts = extensions ?? Array.from(SUPPORTED_EXTENSIONS);
  const uniqueWasm = new Set<string>();
  for (const ext of exts) {
    const config = LANGUAGE_CONFIGS[ext];
    if (config) uniqueWasm.add(config.wasmFile);
  }
  await Promise.all(
    Array.from(uniqueWasm).map(async (wasmFile) => {
      if (!languageCache.has(wasmFile)) {
        const wasmPath = join(WASM_DIR, wasmFile);
        if (existsSync(wasmPath)) {
          try {
            const lang = await ParserClass.Language.load(wasmPath);
            languageCache.set(wasmFile, lang);
          } catch {
            // skip languages that fail to load
          }
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// AST walker
// ---------------------------------------------------------------------------

function walkTree(
  root: any,
  filePath: string,
  content: string,
  config: LanguageConfig,
): ParseResult {
  const symbols: SymbolDef[] = [];
  const imports: ImportDef[] = [];
  const calls: CallDef[] = [];
  const lines = content.split(/\r?\n/);

  // Track current function/class context for call attribution
  const contextStack: Array<{ name: string; type: string; className?: string }> = [];

  function visit(node: any, parentClass?: string) {
    if (!node) return;
    const nodeType = node.type;

    // --- Symbols ---
    // Check methods first when inside a class (Python doesn't distinguish)
    if (parentClass && config.methodNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "method", config, parentClass);
      if (sym) {
        sym.className = parentClass;
        symbols.push(sym);
        contextStack.push({ name: sym.name, type: "method", className: parentClass });
        visitChildren(node, parentClass);
        contextStack.pop();
        return;
      }
    }

    if (config.functionNodes.includes(nodeType) && !parentClass) {
      const sym = extractSymbol(node, filePath, "function", config, parentClass);
      if (sym) {
        symbols.push(sym);
        contextStack.push({ name: sym.name, type: "function", className: parentClass });
        visitChildren(node, parentClass);
        contextStack.pop();
        return;
      }
    }

    // Also handle function nodes inside classes that aren't in methodNodes
    if (parentClass && config.functionNodes.includes(nodeType) && !config.methodNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "method", config, parentClass);
      if (sym) {
        sym.className = parentClass;
        symbols.push(sym);
        contextStack.push({ name: sym.name, type: "method", className: parentClass });
        visitChildren(node, parentClass);
        contextStack.pop();
        return;
      }
    }

    if (config.classNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "class", config);
      if (sym) {
        symbols.push(sym);
        // Visit children with this class as context
        visitChildren(node, sym.name);
        return;
      }
    }

    if (config.interfaceNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "interface", config);
      if (sym) {
        symbols.push(sym);
        visitChildren(node, sym.name);
        return;
      }
    }

    if (config.typeNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "type", config);
      if (sym) {
        symbols.push(sym);
        visitChildren(node, parentClass);
        return;
      }
    }

    if (config.enumNodes.includes(nodeType)) {
      const sym = extractSymbol(node, filePath, "enum", config);
      if (sym) {
        symbols.push(sym);
        visitChildren(node, sym.name);
        return;
      }
    }

    // --- Imports ---
    if (config.importNodes.includes(nodeType) && config.extractImport) {
      const imp = config.extractImport(node, filePath);
      if (imp) imports.push(imp);
      visitChildren(node, parentClass);
      return;
    }

    // --- Calls ---
    if (config.callNodes.includes(nodeType)) {
      const callee = extractCalleeName(node, config);
      if (callee) {
        const ctx = contextStack.length > 0
          ? contextStack[contextStack.length - 1]!
          : null;
        // For methods, use ClassName.methodName as caller
        const caller = ctx
          ? (ctx.className ? `${ctx.className}.${ctx.name}` : ctx.name)
          : "<module>";
        calls.push({
          filePath,
          callerName: caller,
          calleeName: callee,
          line: node.startPosition.row + 1,
        });
      }
    }

    visitChildren(node, parentClass);
  }

  function visitChildren(node: any, parentClass?: string) {
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i), parentClass);
    }
  }

  visit(root, undefined);

  return { symbols, imports, calls };
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbol(
  node: any,
  filePath: string,
  kind: SymbolKind,
  config: LanguageConfig,
  parentClass?: string,
): SymbolDef | null {
  // Get the name
  let name = "";
  const nameField = config.nameField;
  if (nameField) {
    const nameNode = node.childForFieldName(nameField);
    if (nameNode) {
      name = nameNode.text?.trim() ?? "";
    }
  }

  // For C/C++, the name might be in a declarator sub-node
  if (!name && (node.type === "function_definition" || node.type === "declaration")) {
    const declarator = findDeclarator(node);
    if (declarator) {
      name = declarator.text?.trim() ?? "";
      // Strip function parameters from the declarator
      const parenIdx = name.indexOf("(");
      if (parenIdx > 0) name = name.substring(0, parenIdx).trim();
    }
  }

  // For Go method declarations, name might be in a field_identifier
  if (!name && node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) name = nameNode.text?.trim() ?? "";
  }

  // For Ruby methods, name is in the name child
  if (!name && node.type === "method") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) name = nameNode.text?.trim() ?? "";
  }

  // For variable declarations (arrow functions), extract from declarator
  if (!name && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "variable_declarator") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) {
          name = nameNode.text?.trim() ?? "";
          // Check if the value is a function/arrow
          const valueNode = child.childForFieldName("value");
          if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
            break;
          }
          name = ""; // Not a function assignment — reset
        }
      }
    }
  }

  if (!name) return null;

  // Clean up name (remove leading * for Go, etc.)
  name = name.replace(/^\*/, "").trim();
  if (!name) return null;

  // Get parameters
  const params = extractParams(node, config);

  // Check for async
  let isAsync = false;
  if (config.hasAsync) {
    const text = node.text ?? "";
    isAsync = /\basync\b/.test(text.substring(0, 200));
  }

  // Check for export
  let isExported = false;
  if (config.hasExport) {
    const text = node.text ?? "";
    isExported = /\bexport\b/.test(text.substring(0, 200)) ||
      (node.parent && node.parent.type === "export_statement");
  } else if (kind === "function" || kind === "method") {
    // Go: capitalized = exported
    if (config.wasmFile === "tree-sitter-go.wasm") {
      isExported = /^[A-Z]/.test(name);
    }
    // Rust: pub = exported
    if (config.wasmFile === "tree-sitter-rust.wasm") {
      const text = node.text ?? "";
      isExported = /\bpub\b/.test(text.substring(0, 200));
    }
    // Java: public = exported
    if (config.wasmFile === "tree-sitter-java.wasm") {
      const text = node.text ?? "";
      isExported = /\bpublic\b/.test(text.substring(0, 200));
    }
    // C#: public = exported
    if (config.wasmFile === "tree-sitter-c_sharp.wasm") {
      const text = node.text ?? "";
      isExported = /\bpublic\b/.test(text.substring(0, 200));
    }
    // PHP: public = exported
    if (config.wasmFile === "tree-sitter-php.wasm") {
      const text = node.text ?? "";
      isExported = /\bpublic\b/.test(text.substring(0, 200));
    }
    // Dart: export keyword
    if (config.wasmFile === "tree-sitter-dart.wasm") {
      const text = node.text ?? "";
      isExported = /\bexport\b/.test(text.substring(0, 200));
    }
  }

  return {
    name,
    kind,
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported: isExported,
    async: isAsync,
    params,
    className: parentClass,
  };
}

function findDeclarator(node: any): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "function_declarator" || child.type === "declarator") {
      return child;
    }
    const found = findDeclarator(child);
    if (found) return found;
  }
  return null;
}

function extractParams(node: any, config: LanguageConfig): string[] {
  const paramsField = config.paramsField;
  if (!paramsField) return [];

  // Try to get params directly from the node
  let paramsNode = node.childForFieldName(paramsField);

  // For variable declarations (arrow functions), params are inside the arrow_function child
  if (!paramsNode && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
    // Find the variable_declarator → arrow_function → parameters
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "variable_declarator") {
        const valueNode = child.childForFieldName("value");
        if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
          paramsNode = valueNode.childForFieldName(paramsField);
          break;
        }
      }
    }
  }

  if (!paramsNode) return [];

  const params: string[] = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    // Skip punctuation
    if (child.type === "," || child.type === "(" || child.type === ")") continue;
    // Extract the parameter name
    const name = extractParamName(child);
    if (name) params.push(name);
  }

  return params;
}

function extractParamName(node: any): string {
  if (!node) return "";

  // Try to get the "name" field
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text?.trim() ?? "";

  // For typed parameters (Python, Java, etc.), the name might be the first identifier
  if (node.type === "identifier" || node.type === "property_identifier") {
    return node.text?.trim() ?? "";
  }

  // For required_parameter / optional_parameter (Python)
  if (node.type === "required_parameter" || node.type === "default_parameter") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode.text?.trim() ?? "";
  }

  // For parameter_declaration (C/C++/Java)
  if (node.type === "parameter_declaration" || node.type === "formal_parameter") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode.text?.trim() ?? "";
    // Try declarator
    const declarator = node.childForFieldName("declarator");
    if (declarator) return declarator.text?.trim() ?? "";
  }

  // Fallback: first identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === "identifier" || child.type === "property_identifier")) {
      return child.text?.trim() ?? "";
    }
  }

  return node.text?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

function extractCalleeName(node: any, config: LanguageConfig): string | null {
  // For new_expression, the "constructor" field contains the class name
  if (node.type === "new_expression") {
    const ctorNode = node.childForFieldName("constructor");
    if (ctorNode) {
      return cleanCalleeName(ctorNode.text?.trim() ?? "");
    }
    // Fallback: first identifier child
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "identifier") {
        return cleanCalleeName(child.text?.trim() ?? "");
      }
    }
  }

  // For call_expression, the "function" field contains the callee
  const funcNode = node.childForFieldName("function");
  if (funcNode) {
    return cleanCalleeName(funcNode.text?.trim() ?? "");
  }

  // For method_invocation (Java), the "name" field
  const nameNode = node.childForFieldName("name");
  if (nameNode && config.callNodes.includes(node.type)) {
    return nameNode.text?.trim() ?? "";
  }

  // For Python call, the "function" field
  if (node.type === "call") {
    const funcNode = node.childForFieldName("function");
    if (funcNode) return cleanCalleeName(funcNode.text?.trim() ?? "");
  }

  // For Ruby/Lua calls, first child is usually the function name
  if (node.type === "function_call" || node.type === "command") {
    const firstChild = node.child(0);
    if (firstChild) return cleanCalleeName(firstChild.text?.trim() ?? "");
  }

  return null;
}

function cleanCalleeName(name: string): string | null {
  // Remove object prefixes: obj.method → method
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx >= 0) name = name.substring(dotIdx + 1);
  // Remove :: prefixes (C++/Ruby)
  const colonIdx = name.lastIndexOf("::");
  if (colonIdx >= 0) name = name.substring(colonIdx + 2);
  // Remove non-identifier characters
  name = name.replace(/[^A-Za-z0-9_$]/g, "");
  return name || null;
}

// ---------------------------------------------------------------------------
// Import extraction per language
// ---------------------------------------------------------------------------

function extractTsImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;

  // Parse: import { foo, bar } from './path'
  //        import foo from './path'
  //        import * as foo from './path'
  //        import type { Foo } from './path'
  const match = text.match(
    /import\s+(?:type\s+)?(?:(\{[^}]+\})|([A-Za-z_$][\w$]*)|(\*\s+as\s+[A-Za-z_$][\w$]*))\s*(?:,\s*(\{[^}]+\}))?\s+from\s+['"]([^'"]+)['"]/,
  );
  if (!match) return null;

  const names: string[] = [];
  if (match[1]) {
    const inner = match[1].slice(1, -1);
    for (const part of inner.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  if (match[4]) {
    const inner = match[4].slice(1, -1);
    for (const part of inner.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  if (match[2]) names.push(match[2]);
  if (match[3]) {
    const alias = match[3].split(/\s+as\s+/)[1]!.trim();
    names.push(alias);
  }

  const from = match[5]!;
  const resolvedPath = resolveImport(filePath, from);
  return { filePath, names, from, resolvedPath, line };
}

function extractPythonImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;

  // import foo.bar
  // from foo import bar, baz
  if (node.type === "import_statement") {
    const match = text.match(/^import\s+([\w.]+)/);
    if (!match) return null;
    const from = match[1]!;
    return { filePath, names: [from.split(".").pop()!], from, line };
  }

  if (node.type === "import_from_statement") {
    const match = text.match(/from\s+([\w.]+)\s+import\s+(.+)/);
    if (!match) return null;
    const from = match[1]!;
    const namesStr = match[2]!;
    const names: string[] = [];
    for (const part of namesStr.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name && name !== "*") names.push(name);
    }
    return { filePath, names, from, line };
  }

  return null;
}

function extractGoImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import "path" or import ( "path1" "path2" )
  const match = text.match(/"([^"]+)"/);
  if (!match) return null;
  const from = match[1]!;
  const name = from.split("/").pop()!.replace(/-/g, "_");
  return { filePath, names: [name], from, line };
}

function extractRustImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // use foo::bar::baz; or use foo::{bar, baz};
  const match = text.match(/use\s+([\w:]+)(?:::\{([^}]+)\})?/);
  if (!match) return null;
  const from = match[1]!;
  const names: string[] = [];
  if (match[2]) {
    for (const part of match[2].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  } else {
    names.push(from.split("::").pop()!);
  }
  return { filePath, names, from, line };
}

function extractJavaImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import foo.bar.Baz; or import foo.bar.*;
  const match = text.match(/import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/);
  if (!match) return null;
  const from = match[1]!;
  const name = from.split(".").pop()!;
  return { filePath, names: [name === "*" ? "*" : name], from, line };
}

function extractCImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // #include <foo.h> or #include "foo.h"
  const match = text.match(/#include\s+[<"]([^>"]+)[>"]/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from], from, line };
}

function extractCSharpImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // using System; or using System.IO;
  const match = text.match(/using\s+(?:static\s+)?([\w.]+)/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from.split(".").pop()!], from, line };
}

function extractRubyImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // require 'foo' or require_relative 'foo'
  const match = text.match(/require(?:_relative)?\s+['"]([^'"]+)['"]/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from], from, line };
}

function extractPhpImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // use Foo\Bar\Baz; or use Foo\Bar\Baz as Alias;
  const match = text.match(/use\s+([\w\\]+)(?:\s+as\s+(\w+))?/);
  if (!match) return null;
  const from = match[1]!;
  const name = match[2] ?? from.split("\\").pop()!;
  return { filePath, names: [name], from, line };
}

function extractSwiftImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import Foo
  const match = text.match(/import\s+(\w+)/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from], from, line };
}

function extractKotlinImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import foo.bar.Baz
  const match = text.match(/import\s+([\w.]+)/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from.split(".").pop()!], from, line };
}

function extractScalaImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import foo.bar.Baz
  const match = text.match(/import\s+([\w.]+)/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from.split(".").pop()!], from, line };
}

function extractLuaImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // require('foo') or require("foo")
  const match = text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from], from, line };
}

function extractDartImport(node: any, filePath: string): ImportDef | null {
  const text = node.text ?? "";
  const line = node.startPosition.row + 1;
  // import 'package:foo/bar.dart'; or import 'foo.dart';
  const match = text.match(/import\s+['"]([^'"]+)['"]/);
  if (!match) return null;
  const from = match[1]!;
  return { filePath, names: [from], from, line };
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function resolveImport(fromFile: string, from: string): string | undefined {
  if (!from.startsWith(".")) return undefined;
  const dir = dirname(fromFile);
  const resolved = resolve(dir, from);
  const exts = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".rb", ".php",
    ".swift", ".kt", ".scala", ".lua", ".dart",
    "/index.ts", "/index.js", "/index.tsx",
    "/index.py", "/mod.ts", "/mod.go",
  ];
  for (const ext of exts) {
    const candidate = resolved.endsWith(ext) ? resolved : resolved + ext;
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

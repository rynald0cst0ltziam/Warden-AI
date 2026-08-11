/**
 * Warden — the provably-safe context layer for AI coding agents.
 *
 * Public surface for the MVP (Phase 1):
 *   - PruningEngine + per-tool pruning modules (grep, file-read, test/log, generic)
 *   - TaskClassifier (heuristic + pluggable LLM)
 *   - EvalGate (shadow-mode, confidence scoring, manual promotion)
 *   - SqliteStore (local-first state via node:sqlite)
 *   - createMcpServer() — MCP server exposing warden.prune / .status / .report
 *   - runCli() — the `warden` CLI (init, serve, status, promote, revert, hud)
 *
 * Trust invariant (enforced by the pruning framework, not per-module):
 * code blocks, shell commands, and error/stack-trace text are never rewritten
 * or paraphrased — only included or excluded wholesale.
 */

export * from "./classifier/index.js";
export * from "./pruner/index.js";
export * from "./pruner/types.js";
export * from "./pruner/preprocess.js";
export * from "./pruner/router.js";
export * from "./eval/index.js";
export * from "./store/sqlite.js";
export * from "./config/index.js";
export * from "./logging/index.js";
export {
  generateKeyPair,
  savePublicKey,
  loadPublicKey,
  signLicense,
  parseLicense,
  serializeLicense,
  verifyLicense,
  activateLicense,
  currentLicense,
  isLicensed,
  hasFeature,
  generateTestLicense,
  type LicensePayload,
  type License,
} from "./license/index.js";
export { createMcpServer, runMcpServer } from "./server/mcp.js";
export { runCli } from "./cli/index.js";
export { Warden } from "./warden.js";
export type { PruneCallInput, PruneCallResult } from "./warden.js";
export { runDashboard } from "./dashboard/index.js";
export {
  runWatchdog,
  runWatchdogTiered,
  watchdogMode,
} from "./watchdog/index.js";
export { runAutoPromote } from "./autopromote/index.js";
export { exportAuditTrail } from "./audit/export.js";
export {
  setBudgetCap,
  removeBudgetCap,
  listBudgetCaps,
  budgetReport,
  recordSpend,
} from "./budget/index.js";
export { selectContext } from "./context/index.js";
export type {
  ContextRecommendation,
  ContextSelectionResult,
  ContextStore,
} from "./context/index.js";
export { sufficientContext, formatSufficientContext } from "./context/sufficient.js";
export type {
  SufficientContextResult,
  SufficientContextFile,
  RelevantMemory,
  ContextCategory,
  MemoryProvider,
  GitProvider,
} from "./context/sufficient.js";
export { AgentMemory } from "./memory/index.js";
export type { MemoryInput, MemoryResult, MemoryStore } from "./memory/index.js";
export { TaskTracker } from "./eval/outcomes.js";
export type { TaskOutcomeInput, TaskOutcomeStats } from "./eval/outcomes.js";
export { CodeIndex } from "./index/indexer.js";
export type { IndexResult, IndexOptions } from "./index/indexer.js";
export { GraphQuery } from "./index/graph.js";
export type {
  SymbolResult,
  CallResult,
  ImpactResult,
  ArchitectureResult,
} from "./index/graph.js";
export { parseFile, parseFileAsync, isSupported, initParser, preloadLanguages, getSupportedExtensions } from "./index/parser.js";
export type {
  SymbolKind,
  SymbolDef,
  ImportDef,
  CallDef,
  ParseResult,
} from "./index/parser.js";
export {
  ccrHash,
  storeOriginal,
  retrieveOriginal,
  extractCcrMarker,
  appendCcrMarker,
  ccrCleanup,
  ccrSummary,
  CCR_DEFAULT_TTL_DAYS,
} from "./ccr/index.js";
export {
  generateOutputRules,
  estimateOutputSavings,
  ESTIMATED_REDUCTION,
} from "./output/index.js";

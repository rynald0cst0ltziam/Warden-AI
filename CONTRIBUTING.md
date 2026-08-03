# Contributing to Warden

Thanks for your interest in contributing. Warden is a TypeScript, ESM, Node

> = 22.5 project (uses built-in `node:sqlite`).

## Build / test / verify

```bash
npm install
npm run build         # tsup → dist/ (entrypoints: index.js, cli.js)
npm run typecheck     # tsc --noEmit
npm test              # vitest — full test suite
npm run test:watch    # vitest in watch mode
npm run format        # prettier --write .
npm run format:check  # prettier --check .
```

Always run `npm run typecheck` and `npm test` after code changes.

## Architecture (where things live)

- `src/config/` — paths, `WardenConfig`, risk presets, repo-root discovery
- `src/logging/` — stderr-only structured logger (never stdout — that's MCP's JSON-RPC channel)
- `src/store/sqlite.ts` — `node:sqlite`-backed state: rules, shadow_runs, decisions, config_snapshots
- `src/classifier/` — task classifier (heuristic + pluggable LLM); fixed taxonomy in `types.ts`
- `src/pruner/` — pruning engine + per-tool modules; **the trust guard lives in `guard.ts`**
- `src/pruner/preprocess.ts` — output preprocessing (ANSI strip, path shorten, JSON cleanup)
- `src/compress/` — deterministic file compression (memory files)
- `src/eval/` — eval gate: shadow evidence, confidence scoring with decay, manual promotion
- `src/warden.ts` — orchestrator tying classifier + engine + gate + store together
- `src/server/mcp.ts` — MCP server exposing warden tools
- `src/cli/` — `warden` CLI (`init`, `serve`, `status`, `hud`, `promote`, `revert`, `prune`, `compress`, `report`, `doctor`)
- `tests/` — vitest test suite (guard, property-based guard, preprocess, grep, fileread, testlog, generic, compress, license, warden integration, CLI smoke)

## Non-negotiable rules

1. **Pruning only removes, never rewrites.** Code, shell commands, and
   error/stack-trace text must be included-or-excluded wholesale. The guard in
   `src/pruner/guard.ts` enforces this at the framework level — every
   non-annotation line in the pruned output must appear verbatim in the raw
   output. Annotations the engine adds are prefixed with `‹warden›` so the
   guard recognizes them as added, not altered. **Never weaken this guard.**
2. **All logging goes to stderr.** stdout is reserved for MCP JSON-RPC.
3. **Local-first.** No raw content or eval state leaves the machine.
4. **Dependency hygiene.** Pin to versions published >= 7 days ago.
5. **No tiers.** Warden is a single product — one price, all features.

## Adding a new pruning module

1. Create `src/pruner/modules/<name>.ts` exporting a `PruneModule` (see
   `grep.ts` for the shape).
2. Register it in `src/pruner/modules/index.ts` and in the `MODULES` map in
   `src/pruner/index.ts`.
3. Add its `ToolType` to `src/pruner/types.ts` and the MCP `TOOL_TYPES` enum
   in `src/server/mcp.ts` and the CLI `TOOL_TYPES` list in `src/cli/index.ts`.
4. Write tests in `tests/<name>.test.ts` — include a guard invariant test
   (every non-annotation line in pruned output must exist in raw).
5. Run `npm run typecheck`, `npm test`, and `npm run warden prune -t <type> -i <sample>`.

## Conventions

- ESM throughout (`"type": "module"`). Use `node:` prefixes for built-ins.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- Prettier with double quotes, trailing commas, 80-col width.
- No emojis in code or output unless explicitly requested.
- Keep the public surface in `src/index.ts` in sync when adding exports.

## Test conventions

- Test files go in `tests/` with `.test.ts` extension.
- Use vitest (`import { describe, it, expect } from "vitest"`).
- Import source files with `../src/` prefix (vitest config resolves `.js` to `.ts`).
- Every pruning module test must include a guard invariant test.
- Property-based tests use a simple seeded PRNG (see `guard-property.test.ts`).
- Integration tests use a temp directory for the SQLite DB.
- CLI smoke tests run the built CLI as a child process.

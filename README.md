<p align="center">
 <img src="https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/docs/assets/warden-banner.png" alt="Warden" width="800">
</p>

<p align="center">
 <strong>Verified context for AI coding agents.</strong>
</p>

<p align="center">
 <strong>Your AI agent burns tokens on noise. Warden stops that.</strong>
</p>

<p align="center">
 Less context. More signal. Verified.
</p>

<p align="center">
 <a href="https://www.npmjs.com/package/warden-ai"><img src="https://img.shields.io/npm/v/warden-ai.svg?style=for-the-badge&color=blue" alt="npm"></a>
 <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm_Shield-yellow.svg?style=for-the-badge" alt="License"></a>
 <a href="#works-with-30-agents"><img src="https://img.shields.io/badge/works_with-35%2B_agents-orange.svg?style=for-the-badge" alt="35+ agents"></a>
 <a href="#trust-guard"><img src="https://img.shields.io/badge/verified_context-100%25_pass-brightgreen.svg?style=for-the-badge" alt="Verified Context"></a>
 <a href="#privacy"><img src="https://img.shields.io/badge/local_first-no_cloud-blue.svg?style=for-the-badge" alt="Local First"></a>
 <a href="https://warden-io.vercel.app"><img src="https://img.shields.io/badge/website-warden--io-blue.svg?style=for-the-badge" alt="Website"></a>
</p>

<br>

Every token your agent spends on noise is a token it didn't spend on your actual problem. **Warden fixes this.**

Warden is a local context layer for AI coding agents. It drops into Claude Code, Cursor, Codex, Windsurf, Cline, Gemini, and 30+ other agents. Install once. Warden removes unnecessary tool-output noise, preserves important information, indexes your codebase for efficient retrieval, maintains useful memory across sessions — then **verifies that compression did not lose critical information**.

**50-90% fewer tokens. Zero config. Zero cloud. Zero lock-in.**

> **Benchmarked.** 30-task suite. 72.3% overall reduction. 100% guard pass rate. 8ms avg overhead. [See the numbers →](benchmarks/README.md)

## Why Warden?

Most context optimizers simply remove or summarize information. **Warden verifies the reduction.**

```
Raw agent output → Warden → Intelligent reduction → Verification → Agent
```

Warden stands between your coding agent and the firehose of tool output. The agent requests huge amounts of information. Warden decides what actually needs to reach the agent, then verifies the result — every retained line is checked byte-for-byte against the raw output. If anything was altered, the raw ships instead. No exceptions.

This is the differentiator: not just compression, but **verified compression**. You don't have to trust that Warden got it right — the trust guard proves it on every call.

> **Warden AI is a local context layer for AI coding agents. It is not a security firewall, authentication system, agent framework, or infrastructure management tool.**

## Install

**All platforms** (macOS, Linux, Windows, WSL):

```bash
npm install -g warden-ai && warden init
```

**macOS / Linux / WSL** (curl one-liner):

```bash
curl -fsSL https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/install.sh | bash
```

**Windows** (PowerShell one-liner):

```powershell
irm https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/install.ps1 | iex
```

> Windows users: do NOT use the curl command in CMD or PowerShell — `bash` triggers WSL on Windows. Use the PowerShell or npm command above.

~10 seconds · Node >= 22.5 · skips agents you don't have · safe to re-run

`warden init` does everything automatically:

| Step | What happens |
|:-----|:-------------|
| **Register** | Warden registered as MCP server in all detected agents (30+) |
| **Rules** | Agent rules files written (CLAUDE.md, AGENTS.md, .cursorrules, etc.) |
| **Index** | Code index built — call graph, imports, symbols, dead code |
| **Compress** | Memory files compressed to save tokens every future session |

Restart your IDE. Start working normally. Warden runs automatically — no commands to remember, no settings to tune, no levels to pick. Max compression is always on.

> **See it working:** your agent prints `‹warden› saved 4295 tokens (79%)` on every tool call. Run `warden hud` for a live terminal HUD. Run `warden dashboard` for a web UI at http://localhost:7878.

<details>
<summary>Install for one agent, or see what's detected</summary>

```bash
warden doctor          # see which agents are detected (16 checks)
warden init            # re-register after installing a new agent
warden benchmark       # see real benchmark numbers on your own files
```

Warden detects and registers for: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Cline, Roo Code, Continue, VS Code Copilot, Zed, JetBrains, Amazon Q, Gemini CLI, Antigravity, Aider, Goose, OpenHands, opencode, Augment Code, Warp, Cody, Tabnine, Replit AI, and more.

</details>

<br>

## Before / After

Same grep query. Same information. **79% fewer tokens.**

**Without Warden — 4,295 tokens:**

```text
$ grep -rn "function auth" src/
src/auth/login.ts:15:export function login(user) {
src/auth/login.ts:16:  const token = signJWT(user);
src/auth/login.ts:17:  if (!token) throw new Error("no token");
src/auth/login.ts:18:  return { token, user };
src/auth/middleware.ts:45:export function authMiddleware(req, res, next) {
src/auth/middleware.ts:46:  const token = req.headers.authorization;
src/auth/middleware.ts:47:  if (!token) return res.status(401).send("no token");
... (138 more matches)
```

**With Warden — 883 tokens:**

```text
warden_grep({ pattern: "function auth" })

  200 matches → 12 relevant
  ‹warden› removed 50 duplicates
  ‹warden› collapsed 138 low-signal
  guard: every line verbatim ✓
  saved: 4295 → 883 tokens (-79%)

  src/auth/login.ts:15    export function login(user)
  src/auth/login.ts:22    export function logout()
  src/auth/middleware.ts:45    authMiddleware(req,res,next)
  src/auth/token.ts:8     export function generateToken()
  src/auth/token.ts:31    export function verifyToken()
  ... 7 more (use warden_retrieve for full)
```

Every line in the pruned output exists verbatim in the raw — verified by the trust guard.

<br>

## AST-aware read modes

`warden_file_read` now supports 5 read modes beyond the default auto-pruning:

```js
// Signatures only — symbol declarations, no bodies (80-90% savings)
warden_file_read({ filePath: "src/auth.ts", mode: "signatures" })
// → export interface User { ... }
//   export class AuthService { ... }
//   async login(user: string, pass: string): Promise<AuthToken>
//   ...

// One symbol by name — just that function/class body
warden_file_read({ filePath: "src/auth.ts", mode: "symbol", symbolName: "login" })
// → the 7 lines of the login() method, nothing else

// Outline only — structural headers, no bodies
warden_file_read({ filePath: "src/auth.ts", mode: "outline" })

// Imports only — just import statements
warden_file_read({ filePath: "src/auth.ts", mode: "imports" })

// Full — no pruning (when you need everything)
warden_file_read({ filePath: "src/auth.ts", mode: "full" })
```

Powered by the tree-sitter code index. Every line in the output is verbatim from the source file — the trust guard verifies it. When no index is available, falls back to regex-based header detection.

<br>

## MCP proxy mode

Warden can wrap any upstream MCP server and compress its tool descriptions,
inputSchemas, and tool-call responses — and optionally replace the full tool
catalog with a tiny lazy-loading surface:

```jsonc
{
  "mcpServers": {
    "fs-shrunk": {
      "command": "warden",
      "args": ["proxy", "npx", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

The proxy spawns the upstream server, intercepts `tools/list` / `prompts/list` / `resources/list` responses, and compresses `description` fields using Warden's compression engine. Technical identifiers (code, paths, URLs, version numbers) are preserved. All other messages pass through unchanged.

```bash
# Wrap any MCP server (lazy-loading + schema compression ON by default)
warden proxy npx @modelcontextprotocol/server-filesystem /tmp

# Custom fields + debug logging
warden proxy npx @modelcontextprotocol/server-github --fields description,summary --debug

# Compression level
warden proxy npx some-mcp-server --level ultra

# Also prune tools/call response content (guard-verified, removal-only)
warden proxy npx @modelcontextprotocol/server-filesystem /tmp --prune-responses

# Disable lazy-loading (show full tool catalog)
warden proxy npx some-mcp-server --no-lazy

# Disable schema compression (keep full inputSchemas)
warden proxy npx some-mcp-server --no-compress-schema

# All features combined
warden proxy npx some-mcp-server --lazy-level medium --compress-schema --prune-responses
```

### Lazy-loading mode (`--lazy`)

Replaces the full tool catalog with 3 meta-tools. The client sees a tiny
surface and loads schemas on demand:

- `warden_list_tools` — returns a compact index of tool names and short descriptions
- `warden_get_tool_schema` — returns the full inputSchema for one tool
- `warden_invoke_tool` — forwards a `tools/call` to the upstream

The full schemas are cached from the upstream's `tools/list` response and
returned on demand. This reduces initial context by **97.9%** on a 50-tool
server (14,105 → 297 tokens).

Lazy listing levels (`--lazy-level`):

| Level | Format | Description included |
|-------|--------|---------------------|
| `low` | `name(arg1, arg2): full compressed description` | Full (compressed) |
| `medium` | `name(arg1, arg2): first sentence` | First sentence only |
| `high` | `name(arg1, arg2)` | None |
| `max` | `name` | None |

- **On by default**. Disable via `--no-lazy` (or `WARDEN_PROXY_LAZY=0`).
- `--lazy-level` controls compactness (default: `medium`).

### inputSchema compression (`--compress-schema`)

Strips cosmetic JSON-Schema fields that add tokens without affecting validation:
`title`, `default`, `examples`, `$schema`, `$comment`, `readOnly`, `writeOnly`,
unreferenced `$defs`/`definitions`. Compresses `description` strings within
schema properties using Warden's prose compression engine.

**Never touches validation constraints**: `type`, `required`, `enum`, `minimum`,
`maximum`, `pattern`, `items`, `properties`, `additionalProperties`, `oneOf`,
`anyOf`, `allOf`, `not`, `$ref`, `deprecated`, etc. are preserved exactly.

- Measured **21.5% additional reduction** on top of description compression.
- **On by default**. Disable via `--no-compress-schema` (or `WARDEN_PROXY_COMPRESS_SCHEMA=0`).

### Guard-verified response pruning (`--prune-responses`)

Description-only compressors deliberately never touch
`tools/call` responses — rewriting a tool's output is unsafe. Warden can prune
them safely because the **trust guard** enforces that the pruned output is a
verbatim subsequence of the raw: lines are removed, never altered. If the guard
fails or nothing is removed, the original ships untouched.

- Opt-in via `--prune-responses` (or `WARDEN_PROXY_PRUNE_RESPONSES=1`); **off by default**.
- Runs each text content block through Warden's pruning engine (same trust guard as the wrapper tools).
- Measured **~79% reduction** on a large, low-signal tool result — with every retained line byte-for-byte identical to the original.

Works with any MCP client (Claude Code, Cursor, Windsurf, Codex, Gemini). Stdio-based — no HTTP server needed.

<br>

## Benchmarks

30 tasks. Measured, not estimated. One command to reproduce:

```bash
npx tsx benchmarks/run-bench.ts
```

| Category | Tasks | Raw tokens | Pruned tokens | Reduction | Avg overhead |
|:---------|------:|-----------:|--------------:|----------:|-------------:|
| **grep** | 5 | 55,655 | 6,944 | **87.5%** | 17ms |
| **file read** | 5 | 45,360 | 9,814 | **78.4%** | 6ms |
| **generic** (auto-routed) | 5 | 38,166 | 3,495 | **90.8%** | 9ms |
| **shell output** | 5 | 16,556 | 4,226 | **74.5%** | 4ms |
| **file compression** | 5 | 41,763 | 27,933 | **33.1%** | 11ms |
| **test log** | 5 | 17,080 | 7,037 | **58.8%** | 4ms |
| **OVERALL** | **30** | **214,580** | **59,449** | **72.3%** | **8ms** |

- **100% trust guard pass rate** — every pruned line verified verbatim against raw
- **8ms average overhead** — negligible vs agent API latency (1-10s)
- **Shell-output pruning**: 24 command pattern detectors (git log/diff/status, npm install/ls/build, docker logs/build/ps, cargo build, kubectl logs/get, ps aux, find, tree, make, go test/build, pip install, mvn, gradle, rustc, tsc) — 74.5% avg reduction
- **Raw data**: CSV + JSON in `benchmarks/results/`
- **Honest numbers**: [HONEST-NUMBERS.md](benchmarks/HONEST-NUMBERS.md) — what these numbers mean and what they don't
- **Methodology**: [benchmarks/README.md](benchmarks/README.md) — fixtures, task selection, reproduction

<br>

## What it does

**Verified context optimization across eight layers. One MCP server. Zero config.**

| Layer | What it does | Savings |
|:------|:-------------|:-------:|
| **Code intelligence** | Index functions, imports, call sites. Query call graph, impact, dead code | 100x fewer round trips |
| **Context selection** | Recommends files for the task with 2-hop symbol expansion | 80%+ smaller context |
| **Tool output pruning** | `warden_grep`, `warden_file_read`, `warden_run_tests`, `warden_run_command` | 50-91% per call |
| **Agent memory** | Decisions persist across sessions with lifecycle (reaffirm, supersede, archive). Failed approaches surface as warnings | 0 repeated mistakes |
| **Response compression** | Rules drop filler, preamble, narration. Code stays verbatim | 45-65% per reply |
| **File compression** | `warden compress` strips filler from memory files, no LLM call | up to 32% per file |
| **Description compression** | 32 tool descriptions compressed before sending | ~41% per turn |
| **Session continuity** | `warden_handoff` reads previous session at start, writes at end | 0 cold starts |
| **Git context** | File history, blame, churn metrics — know if code is stable or volatile | fewer surprises |
| **Sufficient context** | Unified context: files + past decisions + failed approaches + git volatility + token budget | 90%+ smaller context |
| **Task reports** | Per-task and project-wide reports with overhead timing | measure what matters |

### Safety net — always on

| Mechanism | What it does |
|:----------|:-------------|
| **Trust guard** | Every pruned line verified verbatim against raw. If altered, raw ships instead. |
| **Eval gate** | Rules earn confidence through real samples before going live. |
| **Regression watchdog** | Tracks task success rates. Auto-reverts rules that degrade outcomes. |
| **CCR** | Every cut reversible. Full original cached 7 days. `warden_retrieve` with `--around` and `--lines`. |

<br>

## Code intelligence

```js
// Who calls auth() and what does auth() call?
warden_call_graph({ function: "auth" })
// → Callers: login(), UserService.isValid()
//   Callees: checkToken(), generateToken()

// What's affected if I change src/auth.ts?
warden_impact({ filePath: "src/auth.ts" })
// → Risk: HIGH — 5 dependents, 12 callers

// Project overview in one call
warden_architecture({})
// → TypeScript: 57 files, 251 symbols, 2061 calls

// Find dead code
warden_dead_code({})
// → 3 functions with zero callers

// Search for symbols
warden_search_symbols({ pattern: "auth" })
// → 8 matches across 4 files
```

Powered by **tree-sitter** (WASM — no native compilation, works on Windows/macOS/Linux). Supports **30+ languages** including TypeScript, JavaScript, Python, Go, Rust, Java,  C/C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Lua, Dart, Elixir, and more — extracting functions, classes, methods, interfaces, types, enums, imports, and call sites.

<br>

## Trust guard

40 lines. Read them yourself.

```text
src/pruner/guard.ts — the non-negotiable rule:

Every non-annotation line in the pruned output
must appear verbatim in the raw output.
If it doesn't, the raw is shipped instead.
No exceptions. No heuristics. No silent rewrites.
```

Code, shell commands, and error text are **included-or-excluded wholesale** — never altered. **Safety first, optimization second.**

<br>

## Evolution & measurement

Warden doesn't just prune — it measures itself and evolves its memory.

### Task reports

```bash
warden task-report --all
# WARDEN PROJECT REPORT — ALL TIME
# Total prune calls:     143
# Tokens saved (gross):  186,038
# Reduction:             77.9%
# WARDEN OVERHEAD
#   Processing time:      34ms
#   Overhead tokens:      34 (est.)
#   Net tokens saved:     186,004
```

Per-task or project-wide. Includes overhead timing — Warden measures its own cost and subtracts it from gross savings to report **net tokens saved**.

### Memory lifecycle

Decisions aren't static. They evolve:

```js
warden_memory_save({ category: "decision", title: "Use PostgreSQL", body: "...", sourceType: "documentation", evidence: ["docs/arch.md"] })
warden_memory_reaffirm({ id: 42 })     // decision confirmed again — boosts confidence
warden_memory_supersede({ oldId: 42, newId: 55 })  // old decision replaced
warden_memory_archive({ id: 42 })      // no longer relevant
warden_memory_mark_contested({ id: 42 }) // someone disagrees
```

### Failed approach tracking

When something doesn't work, Warden remembers:

```js
warden_memory_save({ category: "failed_approach", title: "Redis for sessions", body: "Lost persistence in deploy. Do not retry.", outcome: "failure" })
// Later, when starting a similar task:
warden_memory_failed_approaches({ query: "session storage" })
// → WARNING: Redis for sessions — failure. Do not retry.
```

### Sufficient context — one call, everything you need

```js
warden_sufficient_context({ task: "fix auth token expiry", tokenBudget: 2000 })
// → FILES (3 files, categorized, with git churn)
// → PAST DECISIONS (2 recalled decisions)
// → FAILED APPROACHES (1 warning — don't use Redis for this)
// → VOLATILITY NOTES (auth.ts: 8 commits — volatile, expect recent changes)
// → TOKEN ACCOUNTING (budget=2000, used=1847, trimmed=yes)
```

Combines file recommendations, past decisions, failed approach warnings, git volatility, and token budget trimming into a single response. Replaces `warden_context_select` when you want the full picture.

<br>

## Works with 35+ agents

| | | | | |
|:---:|:---:|:---:|:---:|:---:|
| Claude Code | Claude Desktop | Cursor | Windsurf | Codex CLI |
| Cline | Roo Code | Continue | VS Code Copilot | Zed |
| JetBrains | Amazon Q | Gemini CLI | Antigravity | Aider |
| Goose | OpenHands | opencode | Augment Code | Warp |
| Cody | Tabnine | Replit AI | + more | |

**If your agent supports MCP, Warden works with it.**

<br>

## Commands

| Command | What it does |
|:--------|:-------------|
| `warden init` | Register in all agents + write rules + build index + compress files |
| `warden serve` | Run MCP server over stdio (called by agents automatically) |
|| `warden proxy <cmd> [args]` | MCP proxy — wrap any upstream MCP server: compress descriptions, schemas, responses; lazy-loading meta-tools (`--fields`, `--level`, `--debug`, `--prune-responses`, `--lazy`, `--lazy-level`, `--compress-schema`) |
| `warden status` | Rules, confidence, tokens saved, recent memories |
| `warden hud` | Live terminal HUD (Ctrl+C to exit) |
| `warden dashboard` | Web UI at http://localhost:7878 |
| `warden doctor` | Health check — 16 checks, clear pass/fail |
| `warden benchmark` | Run actual benchmarks on real files — see [benchmarks/README.md](benchmarks/README.md) |
| `warden compress <file>` | Compress a memory file (max compression) |
| `warden index` | Index project code structure |
| `warden graph <fn>` | Query call graph: who calls X / what X calls |
| `warden impact <file>` | Impact analysis: blast radius of changes |
| `warden architecture` | Project overview: languages, packages, entry points |
| `warden handoff` | Generate session handoff for next session |
| `warden handoff --read` | Read previous session's handoff |
| `warden ccr` | CCR cache stats |
| `warden ccr retrieve <hash>` | Retrieve original output (`--around`, `--lines`) |
| `warden memory list` | List all stored memories |
| `warden memory recall <query>` | Search memories |
| `warden task-report` | Per-task report: tokens saved, overhead, outcomes (`--all`, `--since`, `--until`, `--task`) |
| `warden git-context <file>` | Git history, blame, churn metrics for a file (`--start`, `--end`, `--blame`) |
| `warden sufficient-context <task>` | Unified context: files + memories + failed approaches + git volatility (`-b` budget) |
| `warden rules` | Write agent rules files |

<br>

## MCP tools

**32 tools. All called automatically by your agent via the rules file.**

| Category | Tools |
|:---------|:------|
| **Tool wrappers** | `warden_grep` · `warden_file_read` · `warden_run_tests` · `warden_run_command` |
| **Context & intelligence** | `warden_context_select` · `warden_sufficient_context` · `warden_index` · `warden_call_graph` · `warden_impact` · `warden_architecture` · `warden_search_symbols` · `warden_dead_code` |
| **Memory** | `warden_memory_save` · `warden_memory_recall` · `warden_memory_list` · `warden_memory_forget` · `warden_memory_failed_approaches` · `warden_memory_reaffirm` · `warden_memory_archive` · `warden_memory_mark_contested` · `warden_memory_reject` |
| **Git context** | `warden_git_context` — history, blame, churn metrics |
| **Eval & outcomes** | `warden_record_outcome` · `warden_outcome_stats` · `warden_task_report` |
| **Status & audit** | `warden_status` · `warden_report` · `warden_prune` · `warden_compress` |
| **CCR (reversibility)** | `warden_retrieve` · `warden_ccr_status` |
| **Session continuity** | `warden_handoff` — `read: true` at start, generate at end |

<br>

## Privacy

```text
No cloud. No API server. No telemetry. No analytics. No phone-home.
Your code, tool outputs, and pruning decisions stay in a local SQLite
file on your machine. It works on a plane.
```

The only network code: **localhost-only dashboard** — bound to127.0.0.1, no external access.

Audit it yourself — the full source is public. The trust guard is 40 lines in `src/pruner/guard.ts`.

<br>

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`)
- **Any MCP-compatible AI coding agent** (30+ supported)

## Tech stack

| Component | Technology |
|:----------|:-----------|
| Runtime | Node.js 22.5+ (built-in `node:sqlite`, no native deps) |
| Language | TypeScript 5.x, ESM |
| MCP protocol | @modelcontextprotocol/sdk |
| Code parsing | tree-sitter WASM (30+ languages, no native compilation) |
| Storage | SQLite (via `node:sqlite`) — FTS5 full-text search |
| Build | tsup (esbuild) |
| Tests | Vitest (546 tests, 35 files) |
| Search | ripgrep (auto-detected, optional) |
| Dashboard | HTTP server, localhost-only, CSP headers |
| CLI | Commander.js |
| License | PolyForm Shield1.0.0 |

## License

PolyForm Shield1.0.0 — source-available, free for everyone including commercial use. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).

## Support Warden

Warden is free and always will be. No paywall, no license key, no gated features. If it saves you tokens, consider a donation:

| Amount | What it does |
|:-------|:-------------|
| **$5** | Say thanks — a small thank-you for a tool you use daily |
| **$10** | Buy lunch — covers development time, the fair price for daily use |
| **$25** | Fund a feature — supports ongoing development and the features you want next |

**PayPal:** [paypal.me/rynald0s](https://paypal.me/rynald0s)

**Bitcoin:** `1Jt3kETWcWkAsNKrc6WsPLKnkkSTe3Uv5o`

Honor system. Warden is fully functional without donating. No gated features, no license keys, no "pro" version. If it saves you tokens and you want to support development, donate. If not, use it free. That's the deal.

---

<p align="center">
 <a href="#install">Install</a> ·
 <a href="https://warden-io.vercel.app">Website</a> ·
 <a href="https://github.com/rynald0cst0ltziam/Warden-AI">GitHub</a> ·
 <a href="https://www.npmjs.com/package/warden-ai">npm</a> ·
 <a href="https://github.com/rynald0cst0ltziam/Warden-AI/issues">Issues</a> ·
 <a href="#support-warden">Donate</a>
</p>

<p align="center">
 Made with ⚡ by Rynaldo Stoltz
</p>

<p align="center">
 <img src="https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/docs/assets/warden-banner.png" alt="Warden" width="800">
</p>

<p align="center">
 <strong>Your AI agent burns tokens on noise. Warden stops that.</strong>
</p>

<p align="center">
 <a href="https://www.npmjs.com/package/warden-ai"><img src="https://img.shields.io/npm/v/warden-ai.svg?style=for-the-badge&color=blue" alt="npm"></a>
 <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm_Shield-yellow.svg?style=for-the-badge" alt="License"></a>
 <a href="#works-with-30-agents"><img src="https://img.shields.io/badge/works_with-30%2B_agents-orange.svg?style=for-the-badge" alt="30+ agents"></a>
 <a href="#trust-guard"><img src="https://img.shields.io/badge/trust_guard-100%25_pass-brightgreen.svg?style=for-the-badge" alt="Trust Guard"></a>
 <a href="#privacy"><img src="https://img.shields.io/badge/local_first-no_cloud-blue.svg?style=for-the-badge" alt="Local First"></a>
 <a href="https://warden-io.vercel.app"><img src="https://img.shields.io/badge/website-warden--io-blue.svg?style=for-the-badge" alt="Website"></a>
</p>

<br>

Every token your agent spends on noise is a token it didn't spend on your actual problem. **Warden fixes this.**

Warden is an MCP server that drops into Claude Code, Cursor, Codex, Windsurf, Cline, Gemini, and 30+ other agents. Install once. Warden prunes tool output, compresses responses, indexes your codebase, and remembers decisions across sessions — then **proves every cut is safe** with a verifiable trust guard.

**50-90% fewer tokens. Zero config. Zero cloud. Zero lock-in.**

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

## What it does

**Eight layers. One MCP server. Zero config.**

| Layer | What it does | Savings |
|:------|:-------------|:-------:|
| **Code intelligence** | Index functions, imports, call sites. Query call graph, impact, dead code | 100x fewer round trips |
| **Context selection** | Recommends files for the task with 2-hop symbol expansion | 80%+ smaller context |
| **Tool output pruning** | `warden_grep`, `warden_file_read`, `warden_run_tests`, `warden_run_command` | 50-91% per call |
| **Agent memory** | Decisions persist across sessions, auto-surface at start | 0 repeated context |
| **Response compression** | Rules drop filler, preamble, narration. Code stays verbatim | 45-65% per reply |
| **File compression** | `warden compress` strips filler from memory files, no LLM call | up to 32% per file |
| **Description compression** | 24 tool descriptions compressed before sending | ~41% per turn |
| **Session continuity** | `warden_handoff` reads previous session at start, writes at end | 0 cold starts |

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

## Works with 30+ agents

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
| `warden status` | Rules, confidence, tokens saved, recent memories |
| `warden hud` | Live terminal HUD (Ctrl+C to exit) |
| `warden dashboard` | Web UI at http://localhost:7878 |
| `warden doctor` | Health check — 16 checks, clear pass/fail |
| `warden benchmark` | Run actual benchmarks on real files |
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
| `warden rules` | Write agent rules files |

<br>

## MCP tools

**24 tools. All called automatically by your agent via the rules file.**

| Category | Tools |
|:---------|:------|
| **Tool wrappers** | `warden_grep` · `warden_file_read` · `warden_run_tests` · `warden_run_command` |
| **Context & intelligence** | `warden_context_select` · `warden_index` · `warden_call_graph` · `warden_impact` · `warden_architecture` · `warden_search_symbols` · `warden_dead_code` |
| **Memory** | `warden_memory_save` · `warden_memory_recall` · `warden_memory_list` · `warden_memory_forget` |
| **Eval & outcomes** | `warden_record_outcome` · `warden_outcome_stats` |
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
| Tests | Vitest (244 tests, 20 files) |
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

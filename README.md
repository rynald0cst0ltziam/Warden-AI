<p align="center">
  <img src="docs/assets/warden-banner.svg" alt="Warden" width="840">
</p>

<p align="center">
  <strong>your agent burns tokens on noise. warden stops that.</strong>
</p>

<p align="center">
  One MCP server. 30+ agents. 91% measured token reduction.<br>
  <strong>No proxy. No cloud. No config. No subscription. No learning curve.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/warden-ai"><img src="https://img.shields.io/npm/v/warden-ai.svg?style=flat-square&color=blue" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square" alt="License"></a>
  <a href="#works-with-30-agents"><img src="https://img.shields.io/badge/works_with-30%2B_agents-orange?style=flat-square" alt="30+ agents"></a>
  <a href="#tests"><img src="https://img.shields.io/badge/tests-244%20passing-brightgreen?style=flat-square" alt="Tests"></a>
  <a href="#trust-guard"><img src="https://img.shields.io/badge/trust%20guard-100%25%20pass-brightgreen?style=flat-square" alt="Trust Guard"></a>
  <a href="#privacy"><img src="https://img.shields.io/badge/local%20first-no%20cloud-blue?style=flat-square" alt="Local First"></a>
  <a href="https://github.com/rynald0cst0ltziam/Warden-AI/commits/main"><img src="https://img.shields.io/github/last-commit/rynald0cst0ltziam/Warden-AI?style=flat-square" alt="Last commit"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#before--after">See it</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#code-intelligence">Code intelligence</a> ·
  <a href="#trust-guard">Trust guard</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#privacy">Privacy</a>
</p>

---

Warden is an MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex, Cursor, Windsurf, Cline, Gemini, and 30+ other agents. Install once. Warden prunes tool output, compresses responses, indexes your codebase, and remembers decisions across sessions — then proves every cut is safe with a verifiable trust guard. You save tokens on every tool call, every reply, every session. Forever.

## Before / After

<table>
<tr>
<th width="50%">🔴 Normal agent — 4,295 tokens</th>
<th width="50%">🟢 Warden agent — 883 tokens</th>
</tr>
<tr>
<td valign="top">

```
$ grep -rn "function auth" src/
src/auth/login.ts:15:export function login(user: string) {
src/auth/login.ts:16:  const token = signJWT(user);
src/auth/login.ts:17:  if (!token) throw new Error("no token");
src/auth/login.ts:18:  return { token, user };
src/auth/login.ts:19:}
src/auth/login.ts:20:
src/auth/login.ts:22:export function logout() {
src/auth/login.ts:23:  clearToken();
src/auth/login.ts:24:  redirect("/login");
src/auth/login.ts:25:}
src/auth/middleware.ts:45:export function authMiddleware(req, res, next) {
src/auth/middleware.ts:46:  const token = req.headers.authorization;
src/auth/middleware.ts:47:  if (!token) return res.status(401).send("no token");
src/auth/middleware.ts:48:  try {
src/auth/middleware.ts:49:    const payload = verify(token);
src/auth/middleware.ts:50:    req.user = payload.user;
src/auth/middleware.ts:51:    next();
src/auth/middleware.ts:52:  } catch (e) {
src/auth/middleware.ts:53:    return res.status(401).send("invalid token");
src/auth/middleware.ts:54:  }
src/auth/middleware.ts:55:}
... (138 more matches)
```

</td>
<td valign="top">

```
warden_grep({ pattern: "function auth" })

  200 matches → 12 relevant
  ‹warden› removed 50 duplicates
  ‹warden› collapsed 138 low-signal
  guard: every line verbatim ✓
  saved: 4295 → 883 tokens (-79%)

  src/auth/login.ts:15  export function login(user)
  src/auth/login.ts:22  export function logout()
  src/auth/middleware.ts:45  authMiddleware(req,res,next)
  src/auth/token.ts:8   export function generateToken()
  src/auth/token.ts:31  export function verifyToken()
  ... 7 more (use warden_retrieve for full)
```

</td>
</tr>
</table>

Same information. 79% fewer tokens. Nothing technical lost. Every line in the pruned output exists verbatim in the raw — verified by the trust guard.

```
┌──────────────────────────────────────────────────┐
│   tool output tokens saved   ██████████     91%  │
│   response tokens saved      ████████      55%  │
│   file tokens saved          ███           32%  │
│   technical accuracy         ██████████    100%  │
│   lines rewritten            ░             0%   │
│   proxy required             ░             no   │
│   cloud required             ░             no   │
│   config required            ░             no   │
│   cost                       ░             free  │
└──────────────────────────────────────────────────┘
```

Warden doesn't shrink what the agent **says**. It shrinks **everything** — tool output, file reads, test runs, shell commands, response prose, memory files, and tool descriptions. Eight layers, one MCP server, zero config.

## Install

**One command. Finds every agent on your machine. Registers for each.**

```bash
# macOS · Linux · WSL · Git Bash
curl -fsSL https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/install.sh | bash

# or npm
npm install -g warden-ai && warden init
```

~10 seconds. Needs Node ≥ 22.5. Skips agents you don't have. Safe to re-run.

`warden init` does everything:
- ✅ Registers Warden as MCP server in all detected agents (30+)
- ✅ Writes agent rules files (CLAUDE.md, AGENTS.md, .cursorrules, etc.)
- ✅ Builds code index — call graph, imports, symbols, dead code
- ✅ Compresses memory files to save tokens every future session

**Restart your IDE. Start working normally.** Warden runs automatically — no commands to remember, no settings to tune, no levels to pick. Max compression is always on.

> [!TIP]
> **See it working:** your agent prints `‹warden› saved 4295 tokens (79%)` on every tool call. Run `warden hud` in a separate terminal for a live savings display. Run `warden dashboard` for a web UI at http://localhost:7878.

<details>
<summary><strong>Install for one agent, or see what's detected</strong></summary>

<br>

```bash
# See which agents are detected on your machine
warden doctor

# Re-register after installing a new agent
warden init

# Check health — 16 checks, clear pass/fail
warden doctor

# See real benchmark numbers on your own files
warden benchmark
```

Warden detects and registers for: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Cline, Roo Code, Continue, VS Code Copilot, Zed, JetBrains, Amazon Q, Gemini CLI, Antigravity, Aider, Goose, OpenHands, opencode, Augment Code, Warp, Cody, Tabnine, Replit AI, and more.

</details>

## What it does

Eight layers. One MCP server. Zero config.

| Layer | What | How | Savings |
|-------|------|-----|---------|
| **1 · 🔍 Code intelligence** | Understand the codebase structurally | Regex-based parser indexes TS, JS, Python. Query call graph, impact analysis, architecture, dead code, symbols — one call replaces dozens of grep/read cycles | **100x fewer round trips** |
| **2 · 📎 Context selection** | Load only relevant files for the task | `warden_context_select` scans project, recommends files matching the task — with 2-hop symbol expansion | **80%+ smaller context** |
| **3 · ✂️ Tool output pruning** | Cut noise from tool outputs | `warden_grep`, `warden_file_read`, `warden_run_tests`, `warden_run_command` — same work as built-in tools, output pruned automatically. File reads use AST-based outlines | **50-91% per call** |
| **4 · 🧠 Agent memory** | Decisions persist across sessions | Auto-surfaces relevant memories at session start. Failed tasks auto-save as patterns | **0 repeated context** |
| **5 · 💬 Response compression** | Agent replies get tighter | Rules tell the agent to drop filler, preamble, narration. Code/commands/errors stay verbatim. Auto-clarity for safety. Always max | **45-65% per reply** |
| **6 · 📄 File compression** | Memory files load faster | `warden compress` strips filler from CLAUDE.md, AGENTS.md. Deterministic, no LLM call, instant | **up to 32% per file** |
| **7 · 🔧 Description compression** | Tool descriptions cost less | 24 tool descriptions compressed before sending. Saves input tokens every turn | **~41% per turn** |
| **8 · 🔗 Session continuity** | Handoffs between sessions | `warden_handoff` reads previous session's state at start, generates compact summary at end. Automatic via rules file | **0 cold starts** |

### The safety net — always on, never optional

| Mechanism | What it does |
|-----------|-------------|
| ✅ **Trust guard** | Every pruned line verified verbatim against raw. If anything was altered, raw ships instead. 40 lines in `src/pruner/guard.ts`. |
| ✅ **Eval gate** | Rules earn confidence through real samples before going live. No blind cuts. |
| ✅ **Regression watchdog** | Tracks task success rates with vs without pruning. Auto-reverts rules that degrade outcomes. |
| ✅ **CCR** | Every cut is reversible. Full original cached 7 days. `warden_retrieve` gets it back instantly. |

## Code intelligence

Warden uses a regex-based parser (no tree-sitter, no native deps) for structural parsing. After `warden init` builds the index, your agent can query:

```js
// Who calls auth() and what does auth() call?
warden_call_graph({ function: "auth" })
// → Callers: login(), UserService.isValid()
//   Callees: checkToken(), generateToken()

// What's affected if I change src/auth.ts?
warden_impact({ filePath: "src/auth.ts" })
// → Risk: HIGH — 5 dependents, 12 callers

// Give me the project overview
warden_architecture({})
// → TypeScript: 57 files, 251 symbols, 2061 calls
//   Entry points: main(), UserService, auth

// Find dead code
warden_dead_code({})
// → 3 functions with zero callers:
//   oldValidateToken() — src/auth.ts:142
//   deprecatedFormat() — src/utils.ts:88

// Search for symbols
warden_search_symbols({ pattern: "auth" })
// → 8 matches across 4 files
```

**One structural query replaces dozens of grep/read cycles.** Instead of reading 20 files to understand the codebase, the agent asks one question and gets the answer. This is the single biggest token saver.

Supports **TypeScript, JavaScript, Python** — functions, classes, methods, interfaces, types, enums, imports, call sites. Covers ~90% of real-world code for these languages.

## Trust guard

40 lines. Read them yourself.

```
src/pruner/guard.ts — the non-negotiable rule:

Every non-annotation line in the pruned output
must appear verbatim in the raw output.
If it doesn't, the raw is shipped instead.
No exceptions. No heuristics. No silent rewrites.
```

Code, shell commands, and error/stack-trace text are **included-or-excluded wholesale** — never altered. If a pruning module ever violates this, the engine refuses to ship the pruned version.

**Safety first, optimization second.**

## Works with 30+ agents

| | | | |
|---|---|---|---|
| Claude Code | Claude Desktop | Cursor | Windsurf |
| Codex CLI | Cline | Roo Code | Continue |
| VS Code Copilot | Zed | JetBrains | Amazon Q |
| Gemini CLI | Antigravity | Aider | Goose |
| OpenHands | opencode | Augment Code | Warp |
| Cody | Tabnine | Replit AI | + more |

**If your agent supports MCP, Warden works with it.**

## Benchmarks

Real token counts from `warden benchmark`. Measured, not estimated.

| Sample | Before | After | Saved | Guard |
|--------|-------:|------:|------:|:-----:|
| grep output (large) | 4,295 | 883 | 79% | ✓ |
| test output (large) | 942 | 217 | 77% | ✓ |
| source: mcp.ts | 8,131 | 319 | 96% | ✓ |
| source: tools.ts | 3,387 | 424 | 87% | ✓ |
| source: warden.ts | 2,595 | 226 | 91% | ✓ |
| source: register.ts | 4,060 | 282 | 93% | ✓ |
| source: sqlite.ts | 5,179 | 246 | 95% | ✓ |
| **TOTAL** | **28,704** | **2,712** | **91%** | **✓** |

File compression:

| File | Before | After | Saved | Valid |
|------|-------:|------:|------:|:-----:|
| CLAUDE.md | 3,452 | 2,783 | 19% | ✓ |
| AGENTS.md | 4,382 | 3,668 | 16% | ✓ |
| README.md | 3,171 | 2,629 | 17% | ✓ |

Response compression: **55% estimated** (max compression, always on)

Run `warden benchmark` yourself to see real numbers on your own files.

> [!IMPORTANT]
> **Honest number warning.** Warden compresses **both** input and output tokens — tool outputs, file reads, test runs, shell commands, response prose, memory files, and tool descriptions. The 91% number is tool output pruning specifically. Whole-session savings depend on your workload. The real win is **your agent works faster, reads less noise, and never loses technical accuracy**. Cost savings are the bonus.

## Commands

| Command | What it does |
|---------|-------------|
| `warden init` | 🚀 Register in all agents + write rules + build index + compress files |
| `warden serve` | ▶️ Run MCP server over stdio (called by agents automatically) |
| `warden status` | 📊 Rules, confidence, tokens saved, recent memories |
| `warden hud` | 📟 Live terminal HUD (Ctrl+C to exit) |
| `warden dashboard` | 🌐 Web UI at http://localhost:7878 |
| `warden doctor` | 🩺 Health check — 16 checks, clear pass/fail |
| `warden benchmark` | 📈 Run actual benchmarks on real files |
| `warden compress <file>` | 📄 Compress a memory file (max compression) |
| `warden index` | 🔍 Index project code structure |
| `warden graph <fn>` | 🔍 Query call graph: who calls X / what X calls |
| `warden impact <file>` | 🔍 Impact analysis: blast radius of changes |
| `warden architecture` | 🔍 Project overview: languages, packages, entry points |
| `warden handoff` | 🔗 Generate session handoff for next session |
| `warden handoff --read` | 🔗 Read previous session's handoff |
| `warden ccr` | 📋 CCR cache stats |
| `warden ccr retrieve <hash>` | 📋 Retrieve original output (supports --around, --lines) |
| `warden memory list` | 🧠 List all stored memories |
| `warden memory recall <query>` | 🧠 Search memories |
| `warden rules` | 📝 Write agent rules files |

## MCP tools (24)

| Tool | Replaces | What it does |
|------|----------|-------------|
| `warden_grep` | built-in grep | Search + prune in one call |
| `warden_file_read` | built-in file read | Read + prune (slice + AST outline) |
| `warden_run_tests` | running tests directly | Run + prune (keep failures) |
| `warden_run_command` | running shell commands | Run + prune (keep errors) |
| `warden_context_select` | reading files blindly | Recommend files for a task (2-hop expansion) |
| `warden_index` | — | Index code structure |
| `warden_call_graph` | grep + read cycles | Who calls X / what X calls |
| `warden_impact` | reading every file | Blast radius of changes |
| `warden_architecture` | reading 20 files | Project overview in one call |
| `warden_search_symbols` | grep for definitions | Find symbols by name |
| `warden_dead_code` | — | Find functions with zero callers |
| `warden_memory_save` | — | Persist a decision across sessions |
| `warden_memory_recall` | — | Find relevant past decisions |
| `warden_memory_list` | — | List all stored memories |
| `warden_memory_forget` | — | Delete a memory |
| `warden_record_outcome` | — | Report task success/failure |
| `warden_outcome_stats` | — | Success rates, regression detection |
| `warden_status` | — | Rules, savings, memories |
| `warden_report` | — | Recent pruning decisions |
| `warden_prune` | — | Prune raw output manually |
| `warden_retrieve` | — | Get full original from CCR cache (supports --around, --lines) |
| `warden_ccr_status` | — | CCR cache state |
| `warden_compress` | — | Compress a file deterministically |
| `warden_handoff` | — | Session handoff — read at start, generate at end |

## Privacy

```
No cloud. No API server. No telemetry. No analytics. No phone-home.
Your code, tool outputs, and pruning decisions stay in a local SQLite
file on your machine. It works on a plane.
```

The only network code:
- **Opt-in Slack webhooks** — you must explicitly configure these
- **localhost-only dashboard** — bound to 127.0.0.1, no external access

Audit it yourself — it's open source. The trust guard is 40 lines in `src/pruner/guard.ts`.

## Tests

```
$ npx vitest run

Test Files  20 passed (20)
     Tests  244 passed (244)
```

Includes property-based guard tests that verify the trust invariant with randomized inputs — the guard is tested against arbitrary content to prove it never lets a rewritten line through.

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`)
- **Any MCP-compatible AI coding agent** (30+ supported)

## License

**MIT** — free, open source, no paywall, no subscription, no telemetry.

---

<p align="center">
  <a href="#install">Install</a> ·
  <a href="https://github.com/rynald0cst0ltziam/Warden-AI">GitHub</a> ·
  <a href="https://www.npmjs.com/package/warden-ai">npm</a> ·
  <a href="https://github.com/rynald0cst0ltziam/Warden-AI/issues">Issues</a>
</p>

<p align="center">
  Made with ⚡ by developers who got tired of watching agents burn tokens on noise.
</p>

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
  <a href="#works-with-35-agents"><img src="https://img.shields.io/badge/works_with-35%2B_agents-orange.svg?style=for-the-badge" alt="35+ agents"></a>
  <a href="#trust-guard"><img src="https://img.shields.io/badge/verified_context-100%25_pass-brightgreen.svg?style=for-the-badge" alt="Verified Context"></a>
  <a href="#privacy"><img src="https://img.shields.io/badge/local_first-no_cloud-blue.svg?style=for-the-badge" alt="Local First"></a>
  <a href="https://warden-io.vercel.app"><img src="https://img.shields.io/badge/website-warden--io-blue.svg?style=for-the-badge" alt="Website"></a>
</p>

<br>

Every token your agent spends on noise is a token it didn't spend on your actual problem. Warden fixes this.

Warden is a local context layer for AI coding agents. It drops into Claude Code, Cursor, Codex, Windsurf, Cline, Gemini, and 30+ other agents. Install once. Warden removes unnecessary tool-output noise while preserving the lines the agent actually needs to see.

**50-90% fewer tokens. Zero config. Zero cloud. Zero lock-in.**

> **Benchmarked.** 30-task suite. 72.3% overall reduction. 100% guard pass rate. 8ms avg overhead.

## Why Warden?

Most context optimizers simply remove or summarize information. **Warden verifies the reduction.**

```text
Raw agent output → Warden → Intelligent reduction → Verification → Agent
```

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

## Trust guard

The trust guard is the non-negotiable rule:

> Every non-annotation line in the pruned output must appear verbatim in the raw output. If it doesn't, the raw is shipped instead.

This means Warden removes lines, never rewrites them.

## Safety net — always on

| Mechanism | What it does |
|:----------|:-------------|
| **Trust guard** | Every pruned line verified verbatim against raw. If altered, raw ships instead. |
| **Eval gate** | Rules earn confidence through real samples before going live. |
| **CCR** | Every cut reversible. Full original cached 7 days. `warden_retrieve` with `--around` and `--lines`. |

## Privacy

```text
No cloud. No API server. No telemetry. No analytics. No phone-home.
Your code, tool outputs, and pruning decisions stay in a local SQLite
file on your machine. It works on a plane.
```

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`)
- **Any MCP-compatible AI coding agent**

## Commands

| Command | What it does |
|:--------|:-------------|
| `warden init` | Register in all agents + write rules + build index + compress files |
| `warden serve` | Run MCP server over stdio |
| `warden status` | Rules, confidence, tokens saved, recent memories |
| `warden hud` | Live terminal HUD |
| `warden dashboard` | Web UI at http://localhost:7878 |
| `warden doctor` | Health check |
| `warden benchmark` | Run benchmarks |
| `warden ccr` | CCR status |
| `warden memory list` | List stored memories |
| `warden task-report` | Per-task report |

## Works with 35+ agents

| | | | | | |
|:---:|:---:|:---:|:---:|:---:|:---:|
| Claude Code | Claude Desktop | Cursor | Windsurf | Codex CLI | Cline |
| Roo Code | Continue | VS Code Copilot | Zed | JetBrains | Amazon Q |
| Gemini CLI | Antigravity | Aider | Goose | OpenHands | + more |

## License

PolyForm Shield 1.0.0 — source-available, free for everyone including commercial use. See [LICENSE](LICENSE).

---

<p align="center">
  <a href="#install">Install</a> ·
  <a href="https://warden-io.vercel.app">Website</a> ·
  <a href="https://github.com/rynald0cst0ltziam/Warden-AI">GitHub</a> ·
  <a href="https://www.npmjs.com/package/warden-ai">npm</a>
</p>

<p align="center">
  Made with ⚡ by Rynaldo Stoltz
</p>

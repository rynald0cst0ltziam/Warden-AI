# Warden — Gap Analysis & Feature Roadmap

> Generated from competitive audit against caveman (98K stars), context-mode (18.6K),
> LeanCTX (3.6K), OpenWolf (2.2K), Serena (28K), Engram (5.9K), claude-mem (28K),
> claude-crusts, claude-code-ctx, local-memory-mcp, sqlite-memory-mcp, and Recall.
>
> Each gap is rated by impact on adoption and relevance to Warden's core mission
> (context pruning + memory + local-first verification).

---

## Current State: What Warden Already Has (That Competitors Don't)

These are unique advantages. No competitor has all of these.

| Feature | What It Does | Who Else Has It |
|---|---|---|
| Trust Guard | 40-line invariant proving pruning only removes, never rewrites. Every line in pruned output must exist verbatim in raw. Property-based tested. | Nobody |
| Shadow Mode + Eval Gate | Rules run in shadow first, earn confidence through real samples, then promote through 3 stages (shadow → canary → active). | Nobody |
| CCR (Reversible Pruning) | Every cut is reversible via SHA-256 hash cache. 7-day TTL. Agent can retrieve full original. | caveman (partial) |
| Regression Watchdog | Auto-reverts rules that degrade outcomes. Confidence decay detection. | Nobody |
| Failed Approach Tracking | Stores approaches that didn't work, recalls them as warnings for future tasks. | Nobody |
| Memory Lifecycle | Full lifecycle: reaffirm, supersede, archive, markContested, reject. | Engram (partial) |
| Git Context Integration | File history, blame, churn metrics built into context selection. | Nobody |
| Unified Sufficient Context Layer | Combines files + memories + failed approaches + git volatility + token budget into one response. | Nobody |
| Budget Caps | Per-seat/per-project token spend limits with period reset. | LeanCTX |

**Verdict: Warden is architecturally superior in safety and verification.**
The gaps below are about distribution, visibility, and feature parity — not
fundamental architecture.

---

## Gap 1: Published Benchmarks (CRITICAL — Do This First)

**Impact: Critical**
**Relevance: Core mission**
**Effort: Medium**

### The Problem

No published benchmarks. No raw data. No reproduction commands. Every successful
competitor publishes receipts:

- caveman: 25-task MicroBench, raw CSV/JSON, one-command reproduction
- LeanCTX: signed savings ledger, crypto-verified
- context-mode: 98% reduction claims with demo GIFs

Without benchmarks, claims of "50-90% reduction" are not credible. Developers
don't believe claims without data. This is the #1 reason for no traction.

### What to Build

A `benchmarks/` directory containing:

```
benchmarks/
├── README.md           # Summary table, methodology, how to reproduce
├── tasks/              # 25 self-contained coding tasks
│   ├── 001-add-healthz/
│   ├── 002-fix-null-pointer/
│   ├── ...
│   └── 025-refactor-to-async/
├── results/
│   ├── raw/            # Per-task CSV + JSON logs
│   ├── summary.csv     # Aggregate results
│   └── summary.json    # Machine-readable summary
└── run-bench.ts        # One-command reproduction script
```

### What to Measure

For each task, run twice (raw agent vs Warden-active), same model, same config:

| Metric | Source |
|---|---|
| Total input tokens | Agent API response usage field |
| Total output tokens | Agent API response usage field |
| Number of tool calls | Count from session log |
| Task success | Manual or test-based verification |
| Wall-clock time | Timestamp before/after |
| Pruning overhead | `performance.now()` around pruneCall (already implemented) |
| Token reduction % | (raw - pruned) / raw * 100 |

### Task Selection Criteria

- Self-contained (completable in one session, no external services)
- Varied difficulty (5 easy, 10 medium, 10 hard)
- Varied type (bug fix, feature add, refactor, test writing, config)
- Realistic (things developers actually do, not synthetic puzzles)
- Verifiable (has a test or clear pass/fail condition)

### Output Format

`benchmarks/README.md` should contain a table like:

```
| Task | Raw tokens | Warden tokens | Reduction | Success | Time |
|------|-----------:|--------------:|----------:|---------|------|
| 001  |    12,400  |       4,200   |    66%    | ✅      | 45s  |
| 002  |     8,900  |       3,100   |    65%    | ✅      | 32s  |
| ...  |       ...  |         ...   |    ...    | ...     | ...  |
| AVG  |    10,650  |       3,650   |    65%    | 24/25   | 38s  |
```

### Honest Numbers Document

Also publish `docs/HONEST-NUMBERS.md` (like caveman) that admits:
- Where Warden adds overhead (pruning computation time)
- Where pruning doesn't help (small outputs, <20 lines)
- Where Warden might hurt (tasks requiring full file context)
- Realistic expectations vs best-case claims

### Where to Post

1. In the repo: `benchmarks/` directory
2. In the main README: summary table + link to raw data
3. On Warden.io: dedicated `/benchmarks` page
4. In HN/Reddit launch posts: link to raw CSV
5. On Twitter/X: screenshot of before/after token counts

### Blockers

Before running benchmarks, fix these (from code audit):

- [ ] **Auto-calculate task outcome tokens** — currently agent self-reports
      `tokensSaved`. Sum actual token differences from decisions/shadow runs
      table instead. Without this, benchmark numbers are agent guesses.
- [ ] **Verify `warden benchmark` CLI command works** — it exists but may not
      produce the output format needed for published benchmarks.

---

## Gap 2: Shell Output Compression (HIGH — Most Visible Waste)

**Impact: High**
**Relevance: Core mission (pruning)**
**Effort: Medium**

### The Problem

Warden's pruning modules cover grep, file-read, test-log, and generic output.
But common shell commands produce huge output that isn't covered:

- `git log` — 500+ lines of commit history
- `npm test` — 200 lines of passing tests, 3 failures buried
- `docker logs` — thousands of log lines
- `cargo build` — compiler warnings + errors mixed with progress
- `pytest -v` — verbose test output
- `kubectl logs` — container logs
- `npm install` — dependency tree dump

Shell output is 2-8% of total tokens (per Florian Bruniaux research). It's not
the biggest cost, but it's the **most visible** — users see it flooding their
context in real-time. It's the "why isn't this compressed?" moment.

### What Competitors Have

- **LeanCTX**: 95+ compression patterns for git, cargo, npm, docker, pytest
- **context-mode**: "Think in Code" — agent writes a script to process output
  instead of reading it raw. Also sandboxes tool output (98% reduction)
- **Token Savior**: 34 Bash output compactors

### What to Build

A new pruning module: `src/pruner/modules/shell-output.ts`

Compression patterns for common commands:

| Command | Raw Output | Compressed Output |
|---|---|---|
| `git log` | 500 lines of commits | Last 10 commits: hash, message, date |
| `npm test` | 200 lines | "47 passed, 3 failed: [list 3 failures with stack]" |
| `docker logs` | 1000 lines | Last 50 lines + error lines highlighted |
| `cargo build` | 300 lines | "Compiled. 2 warnings: [list]. 0 errors." |
| `pytest -v` | 150 lines | "45 passed, 5 failed: [list failures]" |
| `npm install` | 100 lines | "Installed 42 packages. 0 vulnerabilities." |
| `kubectl logs` | 2000 lines | Last 100 lines + any error/crash lines |
| `grep -r` | 500 matches | Top 20 matches by relevance + count |
| `ls -la` | 100 lines | Directory names + file count |
| `ps aux` | 200 lines | Top 10 by CPU/memory |

### How It Fits

- New `PruneModule` registered in `src/pruner/index.ts`
- Pattern detection: match command name + flags to compression strategy
- Trust guard still applies: compressed output lines must exist in raw (for
  verbatim parts; summaries are new text but clearly marked)
- Shadow mode: run in shadow first, eval gate tracks quality

---

## Gap 3: PreToolUse Hooks (HIGH — Proactive vs Reactive)

**Impact: High**
**Relevance: Core mission (pruning)**
**Effort: Medium**

### The Problem

Warden prunes output AFTER it enters context. The output has already been
generated, sent to the agent, and Warden compresses it. But the tokens still
hit the context window momentarily.

Hooks intercept tool calls BEFORE they execute. If an agent tries
`cat /var/log/app.log` (50K tokens), Warden can:
1. Reject it and suggest `tail -100 /var/log/app.log`
2. Run it but only return the last 100 lines
3. Run it through grep with a task-relevant pattern

This is proactive — prevent flooding instead of cleaning up after.

### What Competitors Have

- **context-mode**: PreToolUse hooks intercept Bash, Read, Grep, WebFetch, Agent
  calls. 9 matchers for git log/diff, npm test/install, pytest, pip, cargo,
  docker, make. Redirects through sandbox.
- **OpenWolf**: 7 lifecycle hooks (PreToolUse, PostToolUse, PreCompact, etc.)
- **claude-code-ctx**: PreToolUse on Bash — denies `find /`, `grep -r`,
  `cat /var/log/`, `du -a`. Asks for 17 others (`ls -R`, `tree`, `docker logs`).

### What to Build

Hook integration depends on which agent Warden is connected to. Different
agents have different hook systems:

| Agent | Hook System | How Warden Integrates |
|---|---|---|
| Claude Code | PreToolUse, PostToolUse, PreCompact hooks | Write hook config to `.claude/settings.json` during `warden init` |
| Cursor | No hooks | N/A — pruning only |
| Windsurf | No hooks | N/A — pruning only |
| Codex | Hooks (if supported) | Check during init |
| Gemini CLI | Extensions | Check during init |

For Claude Code (the primary target), write hooks that:

1. **PreToolUse (Bash)**: Check command for known expensive patterns:
   - `find /` → suggest `find . -maxdepth 3`
   - `cat <large_file>` → suggest `warden_file_read` with line range
   - `grep -r <pattern> /` → suggest `warden_grep` with path scope
   - `npm test` → redirect through `warden_run_tests`
   - `docker logs` → suggest `--tail 100`

2. **PreToolUse (Read)**: Check file size before reading:
   - If file > 500 lines → suggest `warden_file_read` with slice
   - If file already read this session → return cached stub

3. **PreCompact**: Inject focus/keep/drop guidance (see Gap 4)

4. **PostToolUse (Bash)**: After `git commit`, trigger snapshot

### How It Fits

- New module: `src/hooks/index.ts`
- Hook config generation during `warden init`
- Hook handlers call existing Warden tools (warden_grep, warden_file_read, etc.)
- Trust guard not needed here (we're preventing, not pruning)

---

## Gap 4: /compact Guidance (MEDIUM — Preserve Critical Context)

**Impact: Medium**
**Relevance: Core mission (context management)**
**Effort: Medium**

### The Problem

When an agent's context gets full, it "compacts" — summarizes the conversation
and drops details. This is a black box. Important context can be lost:
- Which files were being edited
- What decisions were made
- What tasks are in progress
- What errors were encountered

Warden doesn't participate in compaction. It watches it happen.

### What Competitors Have

- **claude-code-ctx**: PreCompact hook adds focus/keep/drop guidance so
  `/compact` preserves the right stuff
- **OpenWolf**: PreCompact snapshot + restore — compaction no longer erases
  what the session did
- **claude-dynamic-context-pruning**: Structured checkpoints that survive
  compaction. State is written to disk before compaction and restored after.

### What to Build

A PreCompact hook (for Claude Code) that injects guidance:

```
When compacting, preserve:
- Current task: [from warden_record_outcome]
- Active files: [from context selection history]
- Recent decisions: [from memory, last 5]
- Failed approaches: [from failed approach tracking]
- Token budget status: [from budget caps]

Drop:
- Tool output that has been pruned (already in CCR cache)
- Passing test output
- File reads that are in the code index
```

Also: a PostCompact handler that restores critical context:

```
After compaction, re-inject:
- Handoff document (from warden_handoff)
- Top 3 relevant memories (from warden_memory_recall)
- Current file context (from warden_context_select)
```

### How It Fits

- Part of the hooks module (Gap 3)
- Uses existing Warden data (memory, context, handoff, budget)
- No new infrastructure needed

---

## Gap 5: AST-Aware Read Modes (HIGH — Biggest Token Cost)

**Impact: High**
**Relevance: Core mission (context pruning)**
**Effort: Medium**

### The Problem

File reads are 40-60% of total token volume (per Florian Bruniaux research).
That's the single biggest cost. Currently, when an agent reads a file, it gets
the whole file. Warden's context selection recommends WHICH files to read, but
doesn't offer different ways to read them.

### What Warden Already Has

- Tree-sitter WASM parser (30+ languages)
- Code index with symbols, imports, calls
- 2-hop symbol expansion in context selection
- File slicing in `warden_file_read` (startLine/endLine)

### What's Missing

The agent can't choose HOW to read a file. It's all-or-nothing (or manual line
ranges). AST-aware read modes let the agent request specific views:

| Mode | What It Returns | Token Savings | Use Case |
|---|---|---|---|
| `signatures` | Function/class/type signatures only, no bodies | 80-90% | "What's in this file?" exploration |
| `outline` | File structure: names, types, no bodies | 85% | Quick scan of a large file |
| `imports` | Only import statements | 95% | Understanding dependencies |
| `diff` | Only lines changed since last read | 95%+ | Re-reading after edits |
| `task-filtered` | Only symbols relevant to current task | 60-80% | Targeted work |
| `symbol` | One specific symbol + its dependencies | 70-90% | "Show me the authMiddleware function" |
| `full` | Entire file (current behavior) | 0% | When you need everything |

### What Competitors Have

- **LeanCTX**: 10 read modes powered by tree-sitter AST analysis across 27
  languages. "Your agent sees structure, not noise."
- **Serena**: Semantic code navigation at symbol level. Language server
  integration. IDE-like capabilities for agents.

### What to Build

Extend `warden_file_read` MCP tool with a `mode` parameter:

```typescript
warden_file_read({
  filePath: "src/auth/middleware.ts",
  mode: "signatures"  // new parameter
})
```

Implementation:
1. Parse file with tree-sitter (already available)
2. Extract relevant nodes based on mode:
   - `signatures`: function_declaration, class_declaration, type_alias, interface
   - `outline`: all top-level declarations, no bodies
   - `imports`: import statements only
   - `diff`: compare with last read version (store hash in CCR)
   - `task-filtered`: use task description to filter symbols (reuse context
     scoring logic)
   - `symbol`: find specific symbol by name, include its dependencies
3. Return formatted output with line numbers for reference

### How It Fits

- Extends existing `warden_file_read` tool
- Uses existing tree-sitter parser
- Uses existing code index for symbol lookup
- Trust guard applies: signatures are verbatim from source
- Shadow mode: run in shadow alongside full reads, compare outcomes

---

## Gap 6: Semantic Search for Memory (MEDIUM — Catch What FTS5 Misses)

**Impact: Medium**
**Relevance: Core mission (memory)**
**Effort: Medium**

### The Problem

Warden's memory uses FTS5 (full-text search) with Porter stemming. FTS5 finds
exact keyword matches. If you save "don't use useEffect for derived state" and
later search "React state calculation mistakes", FTS5 might not find it because
the words don't match.

### What Competitors Have

- **Engram**: Vector search + FTS5 + graph spreading activation (6 signals)
- **local-memory-mcp**: Hybrid retrieval — BM25 + vector cosine via RRF
  (Reciprocal Rank Fusion). Multilingual embeddings, runs locally.
- **sqlite-memory-mcp**: Hybrid retrieval — BM25/FTS5 keyword search fused with
  optional semantic (sqlite-vec) results via RRF
- **Recall**: Local ONNX embeddings (offline), zero network calls

### What to Build

Add vector embeddings alongside FTS5, fused via Reciprocal Rank Fusion:

1. **Embedding model**: Use `sqlite-vec` (SQLite extension for vector search)
   or a local ONNX model (like `all-MiniLM-L6-v2`, 384-dim, runs offline)
2. **Indexing**: When a memory is saved, generate embedding and store in a new
   `memory_embeddings` table
3. **Retrieval**: Run both FTS5 and vector search, fuse results via RRF:
   ```
   RRF_score = 1 / (k + fts5_rank) + 1 / (k + vector_rank)
   where k = 60 (standard constant)
   ```
4. **Fallback**: If embedding model unavailable, fall back to FTS5 only
   (current behavior)

### How It Fits

- Extends existing `src/memory/index.ts`
- New table in SQLite store: `memory_embeddings(memory_id, embedding BLOB)`
- New dependency: `sqlite-vec` (npm package, WASM-based, no native deps)
- FTS5 remains as fallback (already implemented)
- No network calls (embedding model runs locally)

### Trade-off

Adds a dependency (`sqlite-vec`) and increases save latency (embedding
generation). But dramatically improves recall quality. Make it opt-in:
`warden config set memory.semantic true`.

---

## Gap 7: Auto-Contradiction Detection (LOW-MEDIUM — Smart Memory)

**Impact: Low-Medium**
**Relevance: Core mission (memory)**
**Effort: Low**

### The Problem

Warden has `markContested` but it's manual — the agent has to notice that a
new memory contradicts an existing one. In practice, agents rarely do this.

### What Competitors Have

- **local-memory-mcp**: LLM-free contradiction detection + reflection
- **Engram**: `mem_judge` and `mem_compare` tools for conflict surfacing.
  Auto-supersede when later facts contradict earlier ones.
- **sqlite-memory-mcp**: Provenance + reviewable promotion — candidate claims
  move to canonical facts through an approval-aware promotion gate

### What to Build

When `warden_memory_save` is called, before saving:

1. Search existing memories with same tags or similar title (FTS5 + optional
   semantic search from Gap 6)
2. If a memory with opposite intent is found:
   - "Use approach A" vs "Don't use approach A"
   - "Library X is best" vs "Library Y is best for same use case"
3. Auto-mark both as `contested` and notify the agent:
   ```
   "Memory saved, but conflicts with existing memory #42: 'Use Redux for state'.
    Both marked as contested. Agent should clarify which is current."
   ```
4. If the new memory explicitly supersedes an old one (agent says "update" or
   "actually, use X instead"), auto-supersede the old one.

### How It Fits

- Extends `src/memory/index.ts` `save()` method
- Uses existing FTS5 search (or semantic search from Gap 6)
- Uses existing `markContested` and `supersede` methods
- No new infrastructure

---

## Gap 8: TUI — Terminal User Interface (MEDIUM — Developer Experience)

**Impact: Medium**
**Relevance: Developer experience, not core mission**
**Effort: Medium**

### The Problem

Warden has a web dashboard (localhost:7878) but no terminal interface.
Developers — especially the target audience (AI coding agent users) — live in
the terminal. A TUI is faster, works over SSH, and feels native.

### What Competitors Have

- **Engram**: Interactive TUI (`engram tui`) — browse memories, search, stats
- **claude-crusts**: Interactive TUI with Tab completion, session selection

### What to Build

`warden tui` — interactive terminal interface using `ink` (React for CLIs):

```
┌─ Warden ──────────────────────────────────────────────┐
│ Project: my-app    Tokens saved: 847K   Rules: 12     │
├──────────────────────────────────────────────────────┤
│ [1] Live Stats     [4] Memory Browser                 │
│ [2] Rules          [5] Budget                         │
│ [3] Git Context    [6] Open Web Dashboard             │
├──────────────────────────────────────────────────────┤
│ Recent Memories:                                      │
│  #42  decision  Don't use useEffect for derived state │
│  #41  finding   Auth middleware needs token refresh   │
│  #39  pattern   Postgres pool size = 10 for dev       │
│  #38  decision  Use Stripe for payments               │
│  #37  constraint No external network calls            │
├──────────────────────────────────────────────────────┤
│ Rules:                                                │
│  grep-output-trim     active     94% confidence       │
│  file-read-slice      active     91% confidence       │
│  test-log-collapse    active     88% confidence       │
│  shell-git-log        shadow     67% confidence       │
├──────────────────────────────────────────────────────┤
│ q: quit  1-6: navigate  /: search  ?: help            │
└──────────────────────────────────────────────────────┘
```

Views:
1. **Live Stats** — real-time token savings, pruning rate, overhead
2. **Rules** — list all rules, promote/revert, view shadow confidence
3. **Git Context** — file history, blame, churn for current project
4. **Memory Browser** — search, browse, edit memories
5. **Budget** — current spend, caps, alerts
6. **Web Dashboard** — open localhost:7878 in browser

### How It Fits

- New module: `src/tui/index.ts`
- Uses `ink` (React for terminals, npm package, no native deps)
- All data already available from SQLite store
- No new infrastructure

---

## Gap 9: MCP Middleware/Proxy Mode (MEDIUM — Bigger Value Prop)

**Impact: Medium**
**Relevance: Adjacent to core mission**
**Effort: Medium**

### The Problem

Warden compresses its OWN tool descriptions (already implemented). But if the
agent also has Slack, GitHub, Postgres, and other MCP servers connected, those
tool descriptions are uncompressed. 20 tools × 200-word descriptions = 4,000
tokens of tool descriptions sitting in context from OTHER servers.

### What caveman-shrink Does

caveman-shrink is an MCP proxy. It sits between the agent and any MCP server:

```
Agent ←→ caveman-shrink ←→ [Slack MCP, GitHub MCP, Postgres MCP, ...]
```

It intercepts `tools/list` responses and compresses `description` fields using
caveman compression rules. Same tool semantics, fewer tokens.

### What to Build

Warden proxy mode:

```
Agent ←→ Warden (proxy) ←→ [Slack MCP, GitHub MCP, Postgres MCP, ...]
```

In proxy mode, Warden:
1. Spawns upstream MCP servers as subprocesses
2. Intercepts `tools/list` responses from all upstream servers
3. Compresses tool descriptions using Warden's pruning engine
4. Passes compressed list to the agent
5. Forwards tool calls to the correct upstream server
6. Optionally compresses tool call responses too (using shell-output module
   from Gap 2 and file-read modes from Gap 5)

### Configuration

```json
{
  "mcpServers": {
    "warden-proxy": {
      "command": "warden",
      "args": ["proxy"],
      "env": {
        "WARDEN_UPSTREAM": "slack,github,postgres"
      }
    }
  }
}
```

Or auto-wrap during `warden init` — Warden detects existing MCP servers and
wraps them automatically.

### How It Fits

- New module: `src/proxy/index.ts`
- Uses `@modelcontextprotocol/sdk` (already a dependency)
- Reuses existing description compression logic
- Reuses existing pruning modules for response compression
- Trust guard applies to compressed descriptions (verbatim check)

### Marketing Hook

"Warden doesn't just prune your context — it prunes every MCP server you use."

---

## Gap 10: Cross-Machine Sync (LOW — Nice to Have)

**Impact: Low**
**Relevance: Adjacent (developer workflow)**
**Effort: Low**

### The Problem

Developers with desktop + laptop want their memories and rules to sync. Warden
stores everything locally per-project. No sync mechanism.

### What Competitors Have

- **Engram**: Git-based sync — compressed chunks over a git repository you
  control. Optional self-hosted sync server for teams.

### What to Build

Simple export/import:

```bash
warden export --output warden-backup.json
# Transfer file to other machine
warden import --input warden-backup.json
```

Export includes:
- All memories (with lifecycle status)
- All rules (with stage and confidence)
- Budget caps configuration
- Config snapshots

Optional: git-based sync. Store export in a `.warden-sync/` branch, auto-push
on changes, auto-pull on startup.

### How It Fits

- New CLI commands: `warden export`, `warden import`
- Uses existing store serialization
- No new infrastructure (file-based)
- No cloud, no network calls (stays local-first)

---

## Gap 11: Multi-Agent Coordination (LOW — Niche Use Case)

**Impact: Low**
**Relevance: Not core mission**
**Effort: Medium**

### The Problem

When multiple agents work on the same codebase simultaneously, they can
clobber each other. Agent 1 edits `auth.ts` while Agent 2 is also editing
`auth.ts`. No coordination mechanism.

### What Competitors Have

- **Recall**: 6 multi-agent coordination primitives (claim, release, etc.)
- **LeanCTX**: Agent bus, shared sessions, handoff protocols

### What to Build

MCP tools:
- `warden_claim({ filePath })` — "I'm working on this file"
- `warden_release({ filePath })` — "I'm done with this file"
- `warden_whos_working_on({ filePath })` — "Agent 2 claimed it 5 min ago"
- `warden_agent_status()` — "Agent 1: editing auth.ts. Agent 2: editing db.ts."

### Assessment

**Skip for now.** Niche use case. Most developers run one agent at a time.
Adds complexity. Warden's per-project SQLite architecture would make this
straightforward to add later if multi-agent becomes mainstream.

---

## Priority Order

### Do First (Enables Everything Else)

1. **Gap 1: Published Benchmarks** — without this, nothing else matters
   - Blocker: fix auto-calculate task outcome tokens first

### Do Second (Core Feature Parity)

2. **Gap 5: AST-Aware Read Modes** — biggest token cost (file reads 40-60%)
3. **Gap 2: Shell Output Compression** — most visible token waste
4. **Gap 3: PreToolUse Hooks** — proactive vs reactive pruning

### Do Third (Memory & Context Quality)

5. **Gap 4: /compact Guidance** — preserve critical context during compaction
6. **Gap 6: Semantic Search** — catch what FTS5 misses
7. **Gap 7: Auto-Contradiction Detection** — smart memory

### Do Fourth (Developer Experience)

8. **Gap 8: TUI** — developers love it
9. **Gap 9: MCP Middleware Mode** — bigger value prop, marketing hook

### Do Later (Nice to Have)

10. **Gap 10: Cross-Machine Sync** — export/import
11. **Gap 11: Multi-Agent Coordination** — skip for now

---

## Known Code Issues (From Technical Audit)

These should be fixed before publishing benchmarks (Gap 1 depends on accurate
token counting):

| Issue | Severity | Fix |
|---|---|---|
| Memory confidence always 1.0 | Low | Calculate from reaffirm count + age + access frequency, or remove field |
| Empty catch blocks (2-3 in store/sqlite.ts) | Low | Add logging to empty catch blocks |
| Budget DB uses sync ops in async function | Low | Wrap in `setImmediate` or use async SQLite |
| Task outcome tokens are self-reported | Medium | Sum actual token differences from decisions table |
| Test gaps (budget, watchdog, auto-promote, dashboard, handoff, sufficient context) | Medium | Add tests for untested modules |

---

## Competitor Reference Table

Quick reference for what each major competitor has:

| Feature | Warden | caveman | context-mode | LeanCTX | OpenWolf | Serena | Engram |
|---|---|---|---|---|---|---|---|
| Trust Guard | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Shadow Mode + Eval Gate | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reversible Pruning (CCR) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Regression Watchdog | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Memory Lifecycle | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Failed Approach Tracking | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Git Context | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Unified Context Layer | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Budget Caps | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Code Index (tree-sitter) | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| Output Compression | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Dashboard | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Published Benchmarks | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Shell Output Compression | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| PreToolUse Hooks | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| AST-Aware Read Modes | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| /compact Guidance | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Semantic Search | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Auto-Contradiction Detection | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| TUI | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| MCP Middleware | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-Machine Sync | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-Agent Coordination | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Sandbox Execution | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Vector Search | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Hooks (PreCompact etc.) | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |

---

## Summary

Warden has 10 unique features that no competitor has. The gaps are in:

1. **Distribution** (benchmarks, shareable README, viral moment)
2. **Feature parity** (shell compression, hooks, AST read modes)
3. **Memory quality** (semantic search, auto-contradiction)
4. **Developer experience** (TUI, MCP middleware)

The architecture is sound. The code is clean. The unique features (trust guard,
eval gate, CCR) are genuine differentiators. The priority is making these
visible through published benchmarks, then closing the feature gaps that users
expect from competing tools.

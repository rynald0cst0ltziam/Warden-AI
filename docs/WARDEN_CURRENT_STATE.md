# Warden Current State — Discovery Document

**Purpose:** Complete map of Warden's existing infrastructure before beginning
the evolution toward Minimal Sufficient Context. Every claim in this document is
verified against source code, not assumed.

**Date:** 2026-08-11
**Branch:** `feat/evolution-measurement-memory`

---

## 1. Database Architecture

Warden uses two SQLite databases:

### 1.1 Main Database — `.warden/warden.db` (per-project)

Project-local. Created on first `Warden.create()`. Contains all pruning state,
memory, code index, CCR cache, and outcome tracking.

**Pragmas:**
- `journal_mode = WAL` (concurrent access: MCP server + CLI)
- `synchronous = NORMAL`
- `busy_timeout = 5000`

### 1.2 Budget Database — `~/.warden/budgets.db` (global)

User-global. Tracks token spend per scope (seat or project). Separate from
context selection — it is a rate limiter, not an allocator.

---

## 2. Complete Schema Map

### Table: `rules`
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| tool_type | TEXT | NOT NULL |
| name | TEXT | NOT NULL |
| stage | TEXT | NOT NULL DEFAULT 'shadow' |
| created_at | TEXT | NOT NULL |
| promoted_at | TEXT | |
| reverted_at | TEXT | |
| revert_reason | TEXT | |
| config_json | TEXT | NOT NULL DEFAULT '{}' |

Stages: `shadow` → `canary` → `active` → `reverted`.

### Table: `shadow_runs`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| rule_id | TEXT | NOT NULL |
| tool_type | TEXT | NOT NULL |
| timestamp | TEXT | NOT NULL |
| parity_score | REAL | NOT NULL |
| tokens_full | INTEGER | NOT NULL |
| tokens_pruned | INTEGER | NOT NULL |
| notes | TEXT | |

Index: `idx_shadow_rule` on `(rule_id, timestamp)`.

### Table: `decisions`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| timestamp | TEXT | NOT NULL |
| kind | TEXT | NOT NULL |
| rule_id | TEXT | |
| tool_type | TEXT | |
| tokens_saved | INTEGER | NOT NULL DEFAULT 0 |
| detail_json | TEXT | NOT NULL DEFAULT '{}' |

Index: `idx_decisions_ts` on `(timestamp)`.

Kinds: `prune`, `prune-guard-failed`, `observe`, `promote`, `revert`, `canary`.

`detail_json` for prune decisions contains:
```json
{
  "guardOk": true,
  "tokensFull": 12440,
  "tokensPruned": 3201,
  "summary": "removed 9239 tokens (74.3%)",
  "counts": { "linesRemoved": 187, "linesKept": 42 }
}
```

### Table: `config_snapshots`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| timestamp | TEXT | NOT NULL |
| config_json | TEXT | NOT NULL |
| canary_clean | INTEGER | NOT NULL DEFAULT 1 |

Used for watchdog rollback. Not currently active in the evolution scope.

### Table: `memories`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| timestamp | TEXT | NOT NULL |
| category | TEXT | NOT NULL DEFAULT 'decision' |
| title | TEXT | NOT NULL |
| body | TEXT | NOT NULL |
| tags_json | TEXT | NOT NULL DEFAULT '[]' |
| source | TEXT | (nullable, added via migration) |
| confidence | REAL | NOT NULL DEFAULT 1.0 (added via migration, **never calculated**) |
| accessed_at | TEXT | (nullable, added via migration) |
| access_count | INTEGER | NOT NULL DEFAULT 0 (added via migration) |

Indexes: `idx_memories_ts`, `idx_memories_cat`, `idx_memories_accessed`.

Categories: `decision`, `finding`, `pattern`, `constraint`, `preference`.

**Known issue:** `confidence` is always 1.0. No logic calculates it. This
violates the blueprint's "no fake confidence" principle and must be addressed
in P1.

### Table: `memories_fts` (FTS5 virtual table)
| Column | Type |
|--------|------|
| rowid | INTEGER (links to memories.id) |
| title | TEXT |
| body | TEXT |
| tags | TEXT |

Tokenizer: `porter unicode61`. Standalone table (not external-content).
Rebuilt on every migration via `ensureMemoryFts()`.

### Table: `context_selections`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| timestamp | TEXT | NOT NULL |
| task | TEXT | NOT NULL |
| files_json | TEXT | NOT NULL DEFAULT '[]' |
| reasoning | TEXT | |

Index: `idx_context_ts` on `(timestamp)`.

Records *recommendations*, not actual file access. This is a gap for P0
measurement — we know what was suggested, not what was read.

### Table: `task_outcomes`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| timestamp | TEXT | NOT NULL |
| task | TEXT | NOT NULL |
| success | INTEGER | NOT NULL (0/1) |
| pruned | INTEGER | NOT NULL (0/1) |
| tokens_saved | INTEGER | NOT NULL DEFAULT 0 |
| detail_json | TEXT | NOT NULL DEFAULT '{}' |

Index: `idx_outcomes_ts` on `(timestamp)`.

**Current state:** `tokens_saved` is manually reported by the agent (not
auto-calculated from actual pruning decisions). `detail_json` is free-form.
No session ID, no task ID, no file tracking, no test results.

### Table: `index_files`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| project | TEXT | NOT NULL |
| rel_path | TEXT | NOT NULL |
| abs_path | TEXT | NOT NULL |
| mtime | REAL | NOT NULL |
| symbol_count | INTEGER | NOT NULL DEFAULT 0 |

Index: `idx_index_files_project`. Unique: `(project, rel_path)`.

### Table: `index_symbols`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| project | TEXT | NOT NULL |
| file_path | TEXT | NOT NULL |
| name | TEXT | NOT NULL |
| kind | TEXT | NOT NULL |
| start_line | INTEGER | NOT NULL |
| end_line | INTEGER | NOT NULL |
| exported | INTEGER | NOT NULL DEFAULT 0 |
| is_async | INTEGER | NOT NULL DEFAULT 0 |
| params_json | TEXT | NOT NULL DEFAULT '[]' |
| class_name | TEXT | |

Indexes: `idx_index_symbols_name`, `idx_index_symbols_file`,
`idx_index_symbols_kind`.

### Table: `index_imports`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| project | TEXT | NOT NULL |
| file_path | TEXT | NOT NULL |
| line | INTEGER | NOT NULL |
| names_json | TEXT | NOT NULL DEFAULT '[]' |
| from_module | TEXT | NOT NULL |
| resolved_path | TEXT | |

Indexes: `idx_index_imports_file`, `idx_index_imports_resolved`.

### Table: `index_calls`
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| project | TEXT | NOT NULL |
| file_path | TEXT | NOT NULL |
| line | INTEGER | NOT NULL |
| caller_name | TEXT | NOT NULL |
| callee_name | TEXT | NOT NULL |

Indexes: `idx_index_calls_callee`, `idx_index_calls_caller`,
`idx_index_calls_file`.

### Table: `ccr_cache`
| Column | Type | Constraints |
|--------|------|-------------|
| hash | TEXT | PRIMARY KEY |
| raw_output | TEXT | NOT NULL |
| tool_type | TEXT | NOT NULL |
| rule_id | TEXT | NOT NULL |
| tokens_full | INTEGER | NOT NULL |
| tokens_pruned | INTEGER | NOT NULL |
| created_at | TEXT | NOT NULL |
| accessed_at | TEXT | |
| access_count | INTEGER | NOT NULL DEFAULT 0 |

Index: `idx_ccr_created` on `(created_at)`.

### Table: `warden_meta`
| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

Used for handoff tracking (`last_handoff_at`, `last_handoff_doc`).

### Table: `budget_caps` (separate DB)
| Column | Type | Constraints |
|--------|------|-------------|
| scope | TEXT | PRIMARY KEY |
| cap_tokens | INTEGER | NOT NULL |
| period_days | INTEGER | NOT NULL |

### Table: `budget_usage` (separate DB)
| Column | Type | Constraints |
|--------|------|-------------|
| scope | TEXT | PRIMARY KEY |
| spent | INTEGER | NOT NULL |
| period_start | TEXT | NOT NULL |
| alerted | INTEGER | NOT NULL DEFAULT 0 |

---

## 3. Existing Measurement Infrastructure

### 3.1 What is measured today

**Per prune call** (stored in `decisions.detail_json`):
- `tokensFull` — approximate tokens in raw output
- `tokensPruned` — approximate tokens in pruned output
- `tokensSaved` — `tokensFull - tokensPruned` (only when applied + guard passes)
- `guardOk` — whether trust guard verified the pruning
- `summary` — human-readable summary of what was removed
- `counts` — `{ linesRemoved, linesKept }`

Token estimation: `approxTokens()` — rough 4 chars/token. Not a real tokenizer.

**Per rule** (computed from `decisions` table via `ruleStats()`):
- `saved` — total tokens saved by this rule
- `full` — total tokens processed
- `pruned` — total tokens shipped
- `calls` — number of invocations

**Per rule confidence** (computed from `shadow_runs` via `confidence()`):
- Rolling pass-rate over last N shadow runs
- Pass threshold: `PARITY_PASS = 0.95`
- Decay: `effectiveConfidence = max(0, confidence - decayDays * 0.01)`
- `samples`, `daysSinceLastRun`, `decaying`

**Per task** (stored in `task_outcomes`):
- `task` — description string
- `success` — boolean (agent self-reports)
- `pruned` — boolean (was pruning active?)
- `tokensSaved` — manually reported by agent
- `detail_json` — free-form

**Aggregate** (computed on demand):
- `totalTokensSaved()` — `SUM(tokens_saved) FROM decisions WHERE kind='prune'`
- `totalTokensProcessed()` — `SUM(json_extract(detail_json,'$.tokensFull'))`
- `taskOutcomeStats()` — success rates: overall, pruned, raw
- `ccrCount()`, `ccrTokensSaved()` — CCR cache stats

**Context selection** (stored in `context_selections`):
- `task`, `files_json`, `reasoning`
- `tokensFull` and `tokensCompact` computed in `selectContext()` but **not
  persisted to the table** — only returned to the caller

### 3.2 What is NOT measured

| Gap | Impact | P0 sub-priority |
|-----|--------|-----------------|
| No session/task ID correlation | Cannot link prune decisions to specific tasks | P0a |
| No Warden overhead timing | Cannot compute net savings | P0b |
| No tool call counting | Cannot analyze tool usage patterns | P0c |
| No test result parsing | Cannot correlate pruning with test outcomes | P0d (defer) |
| No file access tracking | Cannot measure what was actually read vs recommended | P0d (defer) |
| No input/output token separation | Cannot measure total session token usage | P0d (defer) |
| No memory token cost | Cannot optimize memory retrieval | P2 |
| `tokensSaved` in task_outcomes is manual | Agent may report inaccurate numbers | P0a (auto-calculate) |
| Context selection token stats not persisted | Cannot track context optimization over time | P0a |

---

## 4. Memory System State

### 4.1 Current capabilities

- **Save:** `AgentMemory.save(input)` → dedup by title (case-insensitive), FTS5
  index sync
- **Recall:** `AgentMemory.recall(query)` → FTS5 with Porter stemming, fallback
  to LIKE, access-time touch on each result
- **List:** `AgentMemory.list(limit)` → most recent first
- **Conflict detection:** `AgentMemory.findConflicts(title, category)` → FTS5
  word matching within same category, returns top 5
- **Forget:** `AgentMemory.forget(id)` → deletes memory + FTS5 entry
- **Scoping:** Per-project via `repoRoot` parameter in MCP tools, cached
  `ProjectStore` in MCP server

### 4.2 What is missing for P1

| Blueprint requirement | Current state | Effort |
|------------------------|---------------|--------|
| Structured provenance (source_type, evidence) | `source` is free-form text | Add `source_type` enum + `evidence_json` column |
| Decision scope | Not tracked | Add `scope` column |
| Decision lifecycle (status transitions) | No status field | Add `status` column + `supersedes_id` |
| Failed approach memory | No dedicated category | Add `failed_approach` category + `outcome` field |
| Reaffirm tracking | `access_count` exists but not semantic | Add `reaffirmed_count` + `last_reaffirmed_at` |
| Remove fake confidence | `confidence` always 1.0 | Remove or repurpose to provenance-based signals |

### 4.3 Migration approach

All changes are additive via `ensureColumn()` — no schema rewrite, no data
loss. Existing memories get default values for new columns.

---

## 5. Context Selection State

### 5.1 Current pipeline

`selectContext(task, repoRoot, maxFiles?, store?, codeIndex?)`:
1. Extract task tokens (stopword filtering)
2. Scan project files (skip node_modules, .git, dist, etc.)
3. Score each file: name match (0.25-0.5), extension relevance (0.02-0.05),
   recency (≤0.1), test association (≤0.2), directory proximity (0.08)
4. Rank by score, slice to `maxFiles` (default 15)
5. Extract relevant sections: structural blocks, markdown sections, line-level
6. 2-hop symbol expansion (if code index available): imports + signatures
7. Build compact package: slices + outlines
8. Return `ContextSelectionResult` with `tokensFull` vs `tokensCompact`

### 5.2 What is missing for P2

- No token budget parameter (uses `maxFiles` count, not token budget)
- No context categories (DIRECT, DEPENDENCY, etc.)
- No integration with budget system
- `tokensFull`/`tokensCompact` not persisted to `context_selections` table
- No "minimum sufficient" stopping criterion

### 5.3 Risk note

P2 requires algorithmic redesign of `selectContext`. The "don't rewrite the
core" principle conflicts with making selection budget-aware. Resolution:
add optional `tokenBudget` parameter; when absent, current behavior is
preserved.

---

## 6. Trust Guard State

Complete and robust. No changes needed for the evolution.

- `verifyInclusion(raw, pruned)`: subsequence check — every non-annotation
  line in pruned output must appear verbatim in raw output, in order
- `neverWorse(raw, pruned)`: pruned must not be larger than raw
- Guard failure → fallback to raw output, `guardOk: false`, logged

---

## 7. Evaluation Pipeline State

Complete for current scope. No changes needed for P0.

- Shadow evidence: `recordShadow()` stores parity score + token counts
- Confidence: rolling pass-rate over last N runs, with decay
- Promotion: `promotionEligibility()` → `promote()` (shadow → canary → active)
- Reversion: `revert()` (any → reverted)
- Auto-promotion: licensed feature, `runAutoPromote()`
- Task outcomes: `TaskTracker` with regression detection

---

## 8. Dashboard / Reporting State

### 8.1 CLI

- `warden status` — one-shot snapshot: rules, tokens saved, reduction %
- `warden hud` — live terminal dashboard: 6 sections (header, global, rules,
  system, decisions, memories)
- `warden report` — recent audit trail decisions
- `warden benchmark` — pruning benchmarks on sample files

### 8.2 Web dashboard

- `warden dashboard` — local HTTP server on port 7878
- API endpoints: `/api/status`, `/api/decisions`, `/api/watchdog`, `/api/global`
- Shows: project stats, all-projects stats, savings over time, per-project
  breakdown, rules, budget caps, recent decisions

### 8.3 What is missing for P0

- No per-task report (raw vs optimized token breakdown per task)
- No Warden overhead measurement
- No net savings (gross - overhead)
- No historical trend reports with date ranges
- No comprehensive benchmark suite with baselines

---

## 9. Git Integration State

**None.** No git commands are executed anywhere in the codebase. P3 is
entirely greenfield.

---

## 10. Migration Plan

### P0a — Per-task report from existing data (lowest risk)

**No schema changes required.** All data already exists in `decisions` and
`task_outcomes`. The gap is aggregation and reporting.

Changes:
1. Add `decisionsByTimeRange(start, end)` method to `SqliteStore`
2. Add `taskOutcomesByTimeRange(start, end)` method to `SqliteStore`
3. Add `warden_task_report` MCP tool — aggregates pruning decisions and
   outcomes for a time range or task description
4. Add `warden task-report` CLI command — same aggregation, terminal output
5. Auto-calculate `tokensSaved` in `task_outcomes` by summing `decisions`
   in the same time window (instead of relying on agent self-report)

**Does not modify existing behavior.** Pure addition.

### P0b — Warden overhead timing

Changes:
1. Add `durationMs` to `decisions.detail_json` (via `ensureColumn` not needed
   — it's inside JSON)
2. Wrap `pruneCall()` in `Warden` with `performance.now()` before/after
3. Wrap `verifyInclusion()` in guard with timing
4. Wrap `selectContext()` with timing
5. Store durations in detail_json
6. Add overhead aggregation to task report
7. Display overhead in HUD/dashboard

**Does not modify pruning behavior.** Only adds timing instrumentation.

### P1 — Memory evolution

Schema migrations (all additive via `ensureColumn`):
1. `memories.status` — TEXT DEFAULT 'active' (active, superseded, rejected,
   expired, contested)
2. `memories.scope` — TEXT (nullable, file path or module)
3. `memories.supersedes_id` — INTEGER (nullable, FK to memories.id)
4. `memories.source_type` — TEXT (nullable, enum: human, agent,
   documentation, commit, configuration, code, test,
   explicit_user_instruction)
5. `memories.evidence_json` — TEXT DEFAULT '[]' (array of evidence refs)
6. `memories.outcome` — TEXT (nullable, success/failure/unknown)
7. `memories.reaffirmed_count` — INTEGER DEFAULT 0
8. `memories.last_reaffirmed_at` — TEXT (nullable)

New `AgentMemory` methods:
- `reaffirm(id)` — increment reaffirmed_count, update last_reaffirmed_at
- `supersede(oldId, newId)` — set old.status='superseded', old.supersedes_id
  = newId
- `archive(id)` — set status='expired'
- `markContested(id)` — set status='contested'
- `findFailedApproaches(query)` — recall memories where outcome='failure'

Remove or repurpose `confidence`:
- Option A: Remove the column (breaking change for DBs that have it)
- Option B: Stop writing it, display provenance instead
- **Decision: Option B.** Keep the column for backward compat, stop writing
  fake values, display provenance-based signals instead.

### P3 — Git context

New module `src/git/context.ts`:
- `gitFileHistory(filePath, lines?)` — `git log --follow --pretty=format`
- `gitBlame(filePath, startLine, endLine)` — `git blame -L`
- `gitChangeFrequency(filePath)` — parse log for churn metrics

New MCP tool: `warden_git_context({ filePath, startLine?, endLine? })`
New CLI command: `warden git-context <file> [lines]`

No dependencies on P0-P2. Can be built in parallel.

---

## 11. Test Strategy

Every change gets tests before merging:

- **P0a:** Test that `decisionsByTimeRange` returns correct subset. Test that
  task report aggregates correctly. Test auto-calculated tokensSaved matches
  sum of decisions.
- **P0b:** Test that timing is recorded. Test that overhead is non-negative.
  Test that net savings = gross - overhead.
- **P1:** Test lifecycle transitions. Test supersede sets old status. Test
  failed approach recall. Test provenance fields are stored and retrieved.
- **P3:** Test git history extraction. Test commit messages preserved
  verbatim. Test line range filtering.

All tests follow existing pattern: temp dir, `SqliteStore.open()`, test,
cleanup.

---

## 12. What This Document Does NOT Cover

- P2 (context budget allocator) — requires algorithmic redesign, separate
  design doc needed
- P4 (unified minimal sufficient context) — integration layer, depends on
  P0-P3
- Agent Firewall / Verification Engine / Commerce Intelligence — separate
  products, not in scope
- Benchmark suite expansion — depends on P0 measurement work
- Feedback loop (outcome → selection ranking) — needs concrete design before
  implementation

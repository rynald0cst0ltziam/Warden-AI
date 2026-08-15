# Warden Benchmark Suite

> 30 tasks. Measured, not estimated. One command to reproduce.

## Quick start

```bash
npx tsx benchmarks/run-bench.ts
```

Output:
- Console summary table (see below)
- `results/raw/per-task.csv` — per-task results
- `results/raw/per-task.json` — machine-readable per-task data
- `results/summary.csv` — aggregate by category
- `results/summary.json` — machine-readable summary

## Latest results

### Overall

| Metric | Value |
|---|---|
| Tasks | 30 |
| Raw tokens | 214,580 |
| Pruned tokens | 59,449 |
| Tokens saved | 155,131 |
| **Reduction** | **72.3%** |
| Guard pass rate | 100% |
| Avg overhead | 8ms/task |

### By category

| Category | Tasks | Raw | Pruned | Saved | Reduction | Avg overhead |
|---|---:|---:|---:|---:|---:|---:|
| grep | 5 | 55,655 | 6,944 | 48,711 | 87.5% | 17ms |
| fileread | 5 | 45,360 | 9,814 | 35,546 | 78.4% | 6ms |
| generic | 5 | 38,166 | 3,495 | 34,671 | 90.8% | 9ms |
| shell-output | 5 | 16,556 | 4,226 | 12,330 | 74.5% | 4ms |
| compress | 5 | 41,763 | 27,933 | 13,830 | 33.1% | 11ms |
| testlog | 5 | 17,080 | 7,037 | 10,043 | 58.8% | 4ms |

### Per-task

| ID | Task | Raw | Pruned | Saved | Reduction | Guard | Overhead |
|---|---|---:|---:|---:|---:|---|---:|
| grep-001 | grep: auth middleware (large) | 11,110 | 1,269 | 9,841 | 88.6% | ✓ | 47ms |
| grep-002 | grep: auth middleware (medium) | 11,110 | 1,565 | 9,545 | 85.9% | ✓ | 11ms |
| grep-003 | grep: auth middleware (narrow) | 11,110 | 1,411 | 9,699 | 87.3% | ✓ | 140ms |
| grep-004 | grep: route handlers (broad) | 11,110 | 1,566 | 9,544 | 85.9% | ✓ | 14ms |
| grep-005 | grep: model schema (specific) | 11,110 | 1,133 | 9,977 | 89.8% | ✓ | 8ms |
| test-001 | test: full suite (187 tests) | 3,405 | 1,586 | 1,819 | 53.4% | ✓ | 8ms |
| test-002 | test: auth middleware tests | 3,405 | 1,218 | 2,187 | 64.2% | ✓ | 2ms |
| test-003 | test: API route tests | 3,405 | 978 | 2,427 | 71.3% | ✓ | 3ms |
| test-004 | test: model tests | 3,405 | 1,707 | 1,698 | 49.9% | ✓ | 21ms |
| test-005 | test: service tests | 3,405 | 1,548 | 1,857 | 54.5% | ✓ | 7ms |
| file-001 | file: database service (835 lines) | 9,031 | 827 | 8,204 | 90.8% | ✓ | 4ms |
| file-002 | file: database service (find methods) | 9,031 | 3,714 | 5,317 | 58.9% | ✓ | 4ms |
| file-003 | file: database service (session ops) | 9,031 | 1,287 | 7,744 | 85.7% | ✓ | 3ms |
| file-004 | file: database service (audit log) | 9,031 | 2,689 | 6,342 | 70.2% | ✓ | 5ms |
| file-005 | file: database service (health check) | 9,031 | 1,297 | 7,734 | 85.6% | ✓ | 3ms |
| gen-001 | generic: grep output as generic | 11,110 | 1,273 | 9,837 | 88.5% | ✓ | 5ms |
| gen-002 | generic: test output as generic | 3,405 | 765 | 2,640 | 77.5% | ✓ | 11ms |
| gen-003 | generic: source file as generic | 9,031 | 1,052 | 7,979 | 88.4% | ✓ | 36ms |
| gen-004 | generic: grep output (broad task) | 11,110 | 1,611 | 9,499 | 85.5% | ✓ | 11ms |
| gen-005 | generic: test output (broad task) | 3,405 | 699 | 2,706 | 79.5% | ✓ | 5ms |
| shell-001 | shell: git log (50 commits) | 3,813 | 1,361 | 2,452 | 64.3% | ✓ | 4ms |
| shell-002 | shell: docker logs (server crash) | 5,412 | 1,912 | 3,500 | 64.7% | ✓ | 5ms |
| shell-003 | shell: npm install (487 packages) | 2,020 | 553 | 1,467 | 72.6% | ✓ | 2ms |
| shell-004 | shell: cargo build (150 crates) | 2,532 | 366 | 2,166 | 85.5% | ✓ | 5ms |
| shell-005 | shell: find (147 files) | 2,779 | 34 | 2,745 | 98.8% | ✓ | 6ms |
| comp-001 | compress: source file (lite) | 9,031 | 6,377 | 2,654 | 29.4% | ✓ | 101ms |
| comp-002 | compress: source file (full) | 9,031 | 6,377 | 2,654 | 29.4% | ✓ | 11ms |
| comp-003 | compress: source file (ultra) | 9,031 | 6,343 | 2,688 | 29.8% | ✓ | 33ms |
| comp-004 | compress: grep output (ultra) | 11,110 | 5,857 | 5,253 | 47.3% | ✓ | 36ms |
| comp-005 | compress: test output (ultra) | 3,405 | 2,375 | 1,030 | 30.2% | ✓ | 59ms |

## Methodology

### What we measure

For each task:
1. Load a real fixture file (not synthetic data)
2. Run it through Warden's pruning engine (or compression engine for compress tasks)
3. Measure raw tokens using `approxTokens()` — the same heuristic used in production
4. Measure pruned tokens from actual engine output
5. Verify the trust guard invariant (every line in pruned output exists verbatim in raw)
6. Measure pruning overhead with `performance.now()`

### Token estimation

We use `approxTokens()` — a lexical heuristic that approximates BPE tokenizers by
counting word boundaries, punctuation, and whitespace gaps. This is the same
function used in production (`src/pruner/types.ts`), so benchmark numbers are
consistent with what `warden status` reports.

Real tokenizer counts will differ by 5-15%. This is acceptable for benchmarking
purposes — we're measuring relative reduction, not absolute token counts.

### Fixtures

| Fixture | Size | Lines | Content |
|---|---|---|---|
| `grep-large.txt` | 23KB | 402 | Realistic grep output: auth middleware, API routes, models, utils |
| `test-output-large.txt` | 10KB | 209 | 187 passing tests across 10 test suites |
| `source-large.ts` | 25KB | 835 | Database service module with CRUD, sessions, audit, backup, health |
| `shell-git-log.txt` | 13KB | 392 | 50 git log commits with realistic messages |
| `shell-docker-logs.txt` | 11KB | 163 | Docker container logs with INFO/WARN/ERROR lines |
| `shell-npm-install.txt` | 4KB | 124 | npm install output with 487 packages |
| `shell-cargo-build.txt` | 6KB | 198 | Cargo build output with 150 crates + warnings |
| `shell-find.txt` | 6KB | 147 | find output with 147 file paths |

### Task categories

- **grep** (5 tasks): Same fixture, different task hints. Tests how task relevance
  affects pruning — narrow tasks should prune more than broad tasks.
- **testlog** (5 tasks): Same fixture, different task hints. Tests test output
  collapsing (passing tests summarized, failures kept with context).
- **fileread** (5 tasks): Same fixture, different task hints. Tests file slicing
  and outline extraction.
- **generic** (5 tasks): Same fixtures but routed as "generic" type. Tests
  content-aware routing (auto-detecting type from content).
- **compress** (5 tasks): File compression at lite/full/ultra levels. Tests
  deterministic compression (different mechanism than pruning).
- **shell-output** (5 tasks): Shell command output (git log, docker logs, npm
  install, cargo build, find). Tests the 24-pattern shell-output pruning module
  with content-aware detection and per-command compression strategies.

### Trust guard verification

Every pruning task is verified by the trust guard:
- Every non-annotation line in pruned output must exist verbatim in raw output
- Lines must appear in the same relative sequence (no reordering)
- Pruned output must not be larger than raw (never-worse check)

If any check fails, the raw output is shipped instead and the guard failure is
recorded. In our benchmarks, guard pass rate is 100%.

## Reproduction

```bash
git clone https://github.com/your-org/warden.git
cd warden
npm install
npx tsx benchmarks/run-bench.ts
```

Your numbers should be within 1-2% of ours. The only variance is from
`performance.now()` overhead measurement.

## Raw data

All raw data is in `results/`:

- `results/raw/per-task.csv` — per-task results (CSV, for spreadsheets)
- `results/raw/per-task.json` — per-task results (JSON, for programmatic analysis)
- `results/summary.csv` — aggregate by category (CSV)
- `results/summary.json` — aggregate by category (JSON)

## What these numbers mean and don't mean

See [HONEST-NUMBERS.md](./HONEST-NUMBERS.md) for a full discussion of:
- What the numbers mean (and don't mean)
- What Warden does NOT do
- Why 71.4% is not the same as "71.4% token reduction in your agent session"
- How to verify these numbers yourself

## Adding new tasks

1. Add a fixture file to `fixtures/`
2. Add a task entry to the `TASKS` array in `run-bench.ts`
3. Run `npx tsx benchmarks/run-bench.ts`

Tasks should be:
- Self-contained (no external dependencies)
- Varied (different sizes, types, task hints)
- Realistic (representative of what agents actually see)
- Verifiable (guard must pass)

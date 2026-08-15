# HONEST-NUMBERS.md

> We publish real numbers from real benchmarks. No inflated claims.
> This document admits what Warden does well AND what it doesn't do well.
> Transparency builds trust. If we lie about numbers, we lose credibility forever.

---

## What the benchmarks measure

The benchmark suite (`benchmarks/run-bench.ts`) runs 25 tasks across 5 categories:

| Category | What it tests | Tasks |
|---|---|---|
| grep | Pruning of grep/search output (large code search results) | 5 |
| testlog | Pruning of test runner output (187-test suite) | 5 |
| fileread | Pruning of source file reads (835-line service module) | 5 |
| generic | Content-aware routing (auto-detecting type from generic output) | 5 |
| compress | File compression (lite/full/ultra levels) | 5 |

Each task:
1. Loads a real fixture file (not synthetic data)
2. Runs it through Warden's pruning engine
3. Measures raw tokens vs pruned tokens using `approxTokens()`
4. Verifies the trust guard invariant (every line in pruned output exists verbatim in raw)
5. Measures pruning overhead with `performance.now()`

---

## The numbers (latest run)

### Overall

| Metric | Value |
|---|---|
| Tasks run | 25 |
| Total raw tokens | 197,399 |
| Total pruned tokens | 56,524 |
| Total saved | 140,875 |
| **Overall reduction** | **71.4%** |
| Guard pass rate | 100% |
| Total overhead | 588ms |
| Avg overhead/task | 24ms |

### By category

| Category | Raw | Pruned | Saved | Reduction | Avg overhead |
|---|---:|---:|---:|---:|---:|
| grep | 55,550 | 6,944 | 48,606 | 87.5% | 44ms |
| fileread | 45,155 | 9,814 | 35,341 | 78.3% | 4ms |
| generic | 38,061 | 5,400 | 32,661 | 85.8% | 14ms |
| compress | 41,608 | 27,329 | 14,279 | 34.3% | 48ms |
| testlog | 17,025 | 7,037 | 9,988 | 58.7% | 8ms |

---

## What these numbers mean (and don't mean)

### What they mean

- **71.4% average reduction** is real. Every number is calculated from actual
  pruning engine output, not estimated or self-reported.
- **100% guard pass rate** means the trust guard verified every pruned output:
  every non-annotation line in the pruned output exists verbatim in the raw output.
  No rewriting, no paraphrasing, no hallucination.
- **24ms average overhead** is the time Warden spends pruning. This is negligible
  compared to agent API call latency (typically 1-10 seconds).

### What they DON'T mean

1. **This is not an end-to-end agent benchmark.** We measure how much Warden
   compresses tool output — not how many tokens a full agent session uses. Real
   agent sessions include system prompts, conversation history, file edits, and
   reasoning tokens that Warden doesn't touch. In a real session, Warden's impact
   on TOTAL token usage will be lower than 71.4% because it only prunes tool output,
   not the entire context window.

2. **Token estimates are approximate.** We use `approxTokens()` — a lexical
   heuristic that approximates BPE tokenizers by counting word boundaries,
   punctuation, and whitespace gaps. Real tokenizer counts will differ by 5-15%.
   This is the same heuristic used in production, so the benchmark numbers are
   consistent with what `warden status` reports.

3. **Fixtures are representative but not exhaustive.** We test on:
   - A 400-line grep output (auth middleware + routes + models)
   - A 209-line test output (187 passing tests)
   - An 835-line TypeScript source file (database service)
   
   Real-world outputs vary wildly. Your results will differ. The benchmark
   shows what Warden CAN do, not what it WILL do on every input.

4. **Compression (34.3%) is lower than pruning (78-88%).** File compression
   (used for memory files, rules files) is a different mechanism than tool output
   pruning. It strips filler words and verbose phrasing but keeps all semantic
   content. It's intentionally less aggressive — compressed files must remain
   readable and semantically complete.

5. **Test output pruning (58.7%) is the lowest pruning category.** Test output
   is already fairly dense (one line per test). Warden collapses passing tests
   into summaries and keeps failures with full context, but can't compress as
   much as grep output (which has lots of repetition and irrelevant matches).

6. **No comparison to raw agent sessions.** We don't measure "how many tokens
   does a coding task use with vs without Warden." That would require running
   a real agent (Claude, GPT, etc.) on real tasks with and without Warden
   connected — which costs API credits and is non-deterministic. Our benchmark
   measures the pruning engine's output compression, which is the deterministic
   core of what Warden does.

7. **Token estimates are not exact.** `approxTokens()` is a heuristic. Real
   tokenizer counts differ by 5-15%. We're transparent about this.

8. **No independent validation yet.** These are self-published benchmarks. We
   encourage independent verification — run `npx tsx benchmarks/run-bench.ts`
   yourself and check the numbers.

---

## How to verify these numbers

```bash
git clone https://github.com/rynald0cst0ltziam/Warden-AI.git
cd Warden-AI
npm install
npx tsx benchmarks/run-bench.ts
```

This runs the exact same 25 tasks and outputs:
- Console summary table
- `benchmarks/results/raw/per-task.csv` — per-task results
- `benchmarks/results/raw/per-task.json` — machine-readable per-task
- `benchmarks/results/summary.csv` — aggregate by category
- `benchmarks/results/summary.json` — machine-readable summary

Compare your numbers to ours. They should be within 1-2% (the only variance is
from `performance.now()` overhead measurement).

---

## Changelog

- **2026-08-15**: Initial benchmark published. 25 tasks, 71.4% overall reduction,
  100% guard pass rate. Token auto-calculation fixed (task outcomes now sum from
  decisions table instead of agent self-report).

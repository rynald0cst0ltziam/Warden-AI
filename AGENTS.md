# AGENTS.md — Warden

Guidance for AI coding agents working in this repo.

## What this is

Warden is an MCP server that prunes AI coding agents' tool outputs and proves
the cuts are safe via a shadow-mode eval gate. TypeScript, ESM, Node >= 22.5
(uses built-in `node:sqlite`).

## Build / test / verify commands

- `npm run build` — compile with tsup → `dist/` (entrypoints: `index.js`, `cli.js`)
- `npm run typecheck` — `tsc --noEmit` (type checking)
- `npm test` — run the test suite (vitest) — includes property-based guard tests
- `npm run warden status` — run the CLI via tsx (smoke test that the orchestrator + store + HUD work end-to-end)
- `npm run warden prune -t grep -i <file>` — smoke test the pruning pipeline on a real input
- `npm run format` / `npm run format:check` — prettier

Always run `npm run typecheck` and `npm test` after code changes. If you add
a new module, also run `npm run warden prune -t <type>` to exercise it.

## Architecture (where things live)

- `src/config/` — paths, `WardenConfig`, risk presets, repo-root discovery
- `src/logging/` — stderr-only structured logger (never stdout — that's MCP's JSON-RPC channel)
- `src/store/sqlite.ts` — `node:sqlite`-backed state: rules, shadow_runs, decisions, config_snapshots, code index tables
- `src/classifier/` — task classifier (heuristic + pluggable LLM); fixed taxonomy in `types.ts`
- `src/pruner/` — pruning engine + per-tool modules; **the trust guard lives in `guard.ts`**
- `src/eval/` — eval gate: shadow evidence, confidence scoring with decay, manual promotion
- `src/index/` — code intelligence: tree-sitter WASM parser (`parser.ts`), incremental indexer (`indexer.ts`), graph query engine (`graph.ts`)
- `src/warden.ts` — orchestrator tying classifier + engine + gate + store together
- `src/server/mcp.ts` — MCP server exposing pruning, context, memory, and code intelligence tools
- `src/cli/` — `warden` CLI (`init`, `serve`, `status`, `hud`, `promote`, `revert`, `prune`, `report`, `index`, `graph`, `impact`, `architecture`)

## Non-negotiable rules

1. **Pruning only removes, never rewrites.** Code, shell commands, and
  error/stack-trace text must be included-or-excluded wholesale. The guard in
 `src/pruner/guard.ts` enforces this at the framework level — every
 non-annotation line in the pruned output must appear verbatim in the raw
 output. Annotations the engine adds are prefixed with `‹warden›` so the
 guard recognizes them as added, not altered. **Never weaken this guard.**
2. **All logging goes to stderr.** stdout is reserved for MCP JSON-RPC.
3. **Local-first.** No raw content or eval state leaves the machine in the MVP.
4. **Dependency hygiene.** Pin to versions published >= 7 days ago. The current
 pinned set is in `package.json` — see the commit history for the rationale.
 `@modelcontextprotocol/sdk` is on v1.x (v2 /1.30.0 were too new at scaffold
 time).

## Adding a new pruning module

1. Create `src/pruner/modules/<name>.ts` exporting a `PruneModule` (see
 `grep.ts` for the shape).
2. Register it in `src/pruner/modules/index.ts` and in the `MODULES` map in
 `src/pruner/index.ts`.
3. Add its `ToolType` to `src/pruner/types.ts` and the MCP `TOOL_TYPES` enum
 in `src/server/mcp.ts` and the CLI `TOOL_TYPES` list in `src/cli/index.ts`.
4. Run `npm run typecheck` and `npm run warden prune -t <type> -i <sample>`.

## Conventions

- ESM throughout (`"type": "module"`). Use `node:` prefixes for built-ins.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- Prettier with double quotes, trailing commas, 80-col width.
- No emojis in code or output unless explicitly requested.
- Keep the public surface in `src/index.ts` in sync when adding exports.

<!-- BEGIN WARDEN RULES (managed by `warden init` — do not edit inside this block) -->
# Warden — Context Governance and Verification Layer

This project uses Warden, an MCP server that manages context across eight layers:
code intelligence, context selection, tool output pruning, agent memory, response
compression, file compression, MCP description compression, and session continuity.
It proves every optimization is safe via a shadow-mode eval gate.

## Session start (IMPORTANT — do this first)

At the start of every session in this project, do THREE things in order:

1. Call `warden_handoff` with `{ read: true }` to read the previous session's
 handoff document. This gives you the essential state from the last session —
 decisions made, tasks completed, files touched — so you pick up where the
 previous session left off instead of starting from scratch. Print a one-line
 summary to the user: "Previous session: X decisions, Y tasks, Z files touched."

2. Call `warden_status` and print a one-line summary:
 "Warden active — X tokens saved so far, Y rules live."

3. Call `warden_memory_recall` with a query matching the user's task to find
 relevant past decisions. Print any results that are relevant.

This gives the user visible proof that Warden is working and surfaces project
context from previous sessions.

### If warden_status fails (transport error, tool not found, etc.)

If the warden_status call fails, the MCP server is not connected. Tell the user:
"Warden MCP server not connected. Restart your IDE or run `warden doctor` in a
terminal to diagnose." Then continue with your built-in tools — do NOT silently
skip Warden. The user needs to know it's not working so they can fix it.

## Layer 1: Before starting work — context selection

BEFORE diving into a task, call `warden_context_select` with the task description.
It scans and recommends which files to read, so you load only
relevant context instead of everything.

- Parameters: task (required), repoRoot, maxFiles
- Typical: warden_context_select({ task: "fix null pointer in auth.ts" })
- Read the recommended files first, then proceed with the task.

## Layer 2: During work — tool output pruning

ALWAYS use the Warden wrapper tools instead of your built-in equivalents. The
Warden tools do the same work AND prune the output automatically — no extra
step needed. This is not optional. Every tool call that could produce large
output should go through Warden.

1. **Searching code**: Use `warden_grep` INSTEAD OF your built-in grep/search.
 - It searches files and returns only the matches relevant to the current task.
 - Parameters: pattern (required), path, glob, ignoreCase, maxResults
 - Typical: warden_grep({ pattern: "function auth", path: "src", glob: "*.ts" })

2. **Reading files**: Use `warden_file_read` INSTEAD OF your built-in file read.
 - It reads the file and returns a pruned version (slice + outline for large files).
 - Parameters: filePath (required), startLine, endLine
 - Code is never rewritten — only included or excluded.

3. **Running tests**: Use `warden_run_tests` INSTEAD OF running tests directly.
 - It runs the test command and keeps failures + context, collapses passing noise.
 - Parameters: command (default: "npm test"), cwd

4. **Running commands**: Use `warden_run_command` INSTEAD OF running shell commands.
 - It runs the command and prunes low-signal output, keeping errors and relevant content.
 - Parameters: command (required), cwd, timeout

## Layer 3: After making decisions — memory

When you make a durable project decision (architecture choice, library selection,
convention, constraint), call `warden_memory_save` to persist it:

- Parameters: category, title, body, tags, source
- Categories: "decision" | "finding" | "pattern" | "constraint" | "preference"
- Typical: warden_memory_save({ category: "decision", title: "Use Stripe for payments", body: ". .", tags: ["payments","billing"] })

Only save things that should persist across sessions — not transient task notes.
Use `warden_memory_recall` at the start of future tasks to find relevant decisions.

## Layer 4: After completing a task — record outcome + show savings

After finishing a task, do TWO things:

1. Call `warden_record_outcome` to report whether it succeeded:
 - Parameters: task, success, pruned, tokensSaved
 - Typical: warden_record_outcome({ task: "fix null pointer", success: true, pruned: true, tokensSaved: 500 })

2. Call `warden_status` and print a one-line summary to the user:
 "Warden — X tokens saved this session (Y% reduction)."
 This gives the user visible feedback on savings after each task.

what proves compression didn't degrade outcomes — not that the
right lines were kept, but that the agent's actual performance was maintained.

## Layer 7: Session handoff — at session end or before context compaction

When the session is ending, or when the context window is getting full and may
be compacted, call `warden_handoff` (without `read`) to GENERATE a handoff
document for the next session:

- Typical: warden_handoff({}) — generates a compact summary of this session
- The document covers: decisions made, tasks completed, files touched, tokens saved
- It is stored locally and read by the next session via `warden_handoff({ read: true })`
- Incremental: each handoff covers only the window since the previous one

When to generate a handoff:
- At session end (user says goodbye, done, wrapping up)
- Before context compaction (the agent's context is being trimmed)
- After completing a significant multi-step task (to checkpoint progress)
- When the user asks for a summary of what was done

When NOT to generate a handoff:
- After every small task (use warden_record_outcome instead)
- Mid-task (wait until the task is complete)

## Why use Warden tools

- Saves tokens automatically on every tool call (typically 50-90% reduction)
- Never rewrites code, commands, or error text — only removes irrelevant content
- Every pruning rule is eval-gated: built-in rules are **active by default** (pruning live from install). The trust guard still verifies every cut; use `warden revert` if a rule causes issues. Enterprise mode starts in shadow.
- The trust guard verifies every pruned output: every line must exist verbatim
 in the raw output, or the raw is shipped instead
- Project decisions persist across sessions via the memory system
- Task outcomes are tracked to prove pruning doesn't cause regressions
- Session handoffs ensure continuity — the next session starts with context, not from scratch
- call `warden_status` anytime to show the user how much has been saved
- call `warden_report` to show recent pruning decisions
- call `warden_outcome_stats` to show task success rates

## When NOT to use Warden tools

- Writing files (no Warden equivalent — use your built-in file write)
- Running git commands that produce small output ( use warden_run_command)
- Any operation where the output is already small (< 20 lines)

## Coding principles — surgical changes

When making code changes, follow these rules to minimize wasted tokens and
avoid regressions:

1. **Surgical changes only.** Touch only what the task requires. Don't
 "improve" adjacent code, reformat, or add type hints while fixing a bug.
 Every changed line should trace directly to the request.
2. **Simplicity first.** No features beyond what was asked. No abstractions
 for single-use code. If 200 lines could be 50, rewrite it.
3. **State assumptions explicitly.** If something is ambiguous, ask — don't
 silently pick an interpretation.
4. **Verify before asserting.** Don't guess APIs, versions, or file paths.
 Read the code or docs first.
## Response compression — ultra (automatic)

Warden compresses what goes INTO the agent (tool outputs, file context). But
the agent's OUTPUT to the user is also a major token sink. Apply these rules
to EVERY response. This is active every response, no exceptions. Do not revert
to verbose prose after many turns. Do not drift back to filler. If unsure,
stay concise. The only time to stop: user says "stop compressing" or "normal
mode".

### Hard rules — always apply (all levels)

1. **No preamble.** Start with the answer. Not "Let me look at this" or "I'll
 analyze the code." state what you found or did.
2. **No postamble.** End with the result. Not "Let me know if you need anything
 else" or "Feel free to ask if you have questions."
3. **No echo.** Do NOT restate code, commands, or output that is already on
 screen. The user saw it. Refer to it by name, don't paste it back.
4. **No narration.** Do NOT describe what you're about to do. Do it, then
 state the outcome. "Fixed." not "I'm going to fix this by changing the
 null check on line 42 to use optional chaining."
5. **No restating the question.** The user knows what they asked.
6. **No "TL; DR" or "Summary" sections.** If the response is short enough to
 need a summary, it's short enough to BE the summary.
7. **No tool-call narration.** Don't say "Let me search for. ." or "I'll now
 read the file. ." — call the tool and report the result.
8. **No decorative elements.** No emoji, no decorative tables, no decorative
 dividers, no ASCII art borders. These cost tokens and add nothing.

### Word-level compression

Drop these words entirely (they add tokens, not meaning):
- Filler: "", "", "", "", "", "",
 "", "", "", "", "", "",
 "rather", "somewhat", "fairly", "pretty" (as intensifier), "", "",
 "", "", "", "typically", "usually", ""
- Pleasantries: "sure", "happy to help", "", "", "",
 "no problem", "great question", "good point", "I'd be happy to"
- Hedging: "perhaps", "maybe", "might", "could be", "it seems", "I think",
 "I believe", "likely", "probably", "possibly", "it appears", "arguably"
- Self-reference: "I will", "I'm going to", "Let me", "Now I'll", "Next I",
 "I need to", "I should", "I can see that", "I notice that", "I found that",
 "I see", "I notice", "Let's", "We should"
- Transitions: "so", "therefore", "thus", "hence", "", "now then",
 "alright", "okay so", "well", "moving on", "next up", ""
- Verbose phrases → short equivalents:
 - "to" → "to"
 - "because" → "because"
 - "if" → "if"
 - "now" → "now"
 - "for" → "for"
 - "although" → "although"
 - "about" → "about"
 - "" → (delete entirely)
 - "" → (delete entirely)
 - "" → (delete entirely)

### Structural compression

- **Sentence fragments** when meaning is clear. "Null pointer on line 42."
 not "There is a null pointer dereference on line 42 of the auth module."
- **One line** when one line suffices. If the fix is one line, show one line.
- **Bullet lists** for 3+ items. No prose paragraphs for lists.
- **No "Before/After" framing.** show the result.
- **No section headers** for single-item sections. A header + one bullet = 2x
 tokens for zero information.
- **No "Approach" or "Plan" sections.** Execute, don't narrate the plan.
- **No "Explanation" sections** unless the user asked "why".
- **Short synonyms.** "fix" not "implement a solution for". "use" not
 "utilize". "start" not "initiate". "end" not "terminate". "show" not
 "demonstrate". "check" not "verify the correctness of".

### Structural compression (ultra)

- Everything in "full" level, plus:
- **Drop articles** (a/an/the) when meaning is clear without them.
 "Fixed null pointer in auth.ts" not "Fixed the null pointer in the auth.ts"
- **Drop conjunctions** when fragments connect naturally.
 "Token expired. Rejected request." not "Token expired and rejected the request."
- **One word** when one word is enough. "Yes." "No." "Done." "Fixed."
- **Strip modal verbs** (would/could/should/might) when stating facts.
 "Causes crash" not "This could cause a crash."
- **Drop "there is/are"** starters. "Bug in line 42" not "There is a bug in line 42."
- **Imperative mood** for instructions. "Run npm test" not "run npm test."

### Code output

- Show only the changed lines, not the full function/file. Use comments to
 indicate context: `// ... existing code ...`
- If showing a diff, use unified diff format — not "Here's the old code" +
 "Here's the new code" as two separate blocks
- If the code is already in the user's file, say "updated src/auth.ts" —
 don't paste the full file back
- Inline code for single identifiers: `authMiddleware` not a fenced block
- No "Here's the updated code:" preamble before code blocks. show the code.
- No "This code does X" explanation after code blocks unless the user asked.

### Never compress these (verbatim, always — all levels)
- Code blocks (fenced or inline) — byte-for-byte exact
- Commands, file paths, URLs — verbatim
- Error messages and stack traces — verbatim
- API names, library names, technical terms — verbatim
- Numbers and measurements — verbatim
- Commit keywords: feat, fix, refactor, docs, test, chore
- Git SHAs, hashes, IDs — verbatim
- JSON/YAML/TOML/XML — verbatim (structural data, not prose)
- Log output — verbatim
- Configuration values — verbatim

### Never invent abbreviations
Tokenizers split invented abbreviations the same as the full word — zero
tokens saved, readability lost. This is measured, not opinion.
- BAD: "cfg", "impl", "req", "res", "fn", "auth" (when it means "authentication"),
 "deps", "dir", "tmp", "var", "lib", "msg", "obj", "param", "ret", "sync"
- GOOD: "config", "implement", "request", "response", "function", "authentication",
 "dependencies", "directory", "temporary", "variable", "library", "message",
 "object", "parameter", "return", "synchronous"
- Exception: standard tech acronyms that are already tokens: API, DB, HTTP,
 URL, CLI, ORM, SQL, JSON, XML, YAML, CSS, HTML, DNS, SSH, TCP, UDP, TLS,
 JWT, OAuth, CRUD, REST, GraphQL
- No causal arrows (→) either — own token, save nothing. Use "causes" or "=".

### Auto-clarity — switch to full prose for high-risk situations
When the situation is high-risk, temporarily stop compressing and use full,
clear sentences. Resume compression after the clear part is done. This is
not optional — safety beats token savings:
- Security warnings
- Irreversible action confirmations (delete, drop, force-push, overwrite, deploy)
- Multi-step sequences where fragment order risks misread
- User asks to clarify or repeats the question (they didn't understand)
- Error messages that need full context to be actionable
- Breaking changes or migration steps
- Anything involving data loss, security, or production systems

### Examples

Bad (69 tokens): "The reason your React component is re-rendering is likely. you're creating a new object reference on each render cycle. When you
pass an inline object as a prop, React's shallow comparison sees it as a
different object every time, which triggers a re-render. I'd recommend using
useMemo to memoize the object."
Good (19 tokens): "New object ref each render. Inline object prop = new ref
= re-render. Wrap in useMemo."

Bad (45 tokens): "I'll go ahead and fix the authentication middleware now.
The issue is that the token expiry check is using a less-than comparison
instead of a less-than-or-equal comparison, which causes tokens to be
rejected one second before they expire."
Good (15 tokens): "Token expiry uses < not <=. Tokens rejected 1s early.
Fixed."

Bad (32 tokens): "Let me go ahead and create a new file for the database
connection. I'll name it db.ts and put it in the src/lib directory."
Good (8 tokens): "Created src/lib/db.ts for database connection."
## Layer 6: File compression — compress memory files

Memory files (like this one) are loaded into context every session. Verbose
memory files waste tokens forever, not once. Compress them:

```
warden compress <file>           # compress in place, max compression
warden compress <file> --dry-run # preview without writing
```

Strips filler words and verbose phrases while preserving code blocks,
commands, URLs, file paths, and inline code byte-for-byte. Free, instant,
offline — no LLM call needed. Original backed up to `<file>.original`.

For more aggressive compression, rephrase the remaining prose yourself —
you have an LLM. Warden handles the deterministic bulk cut, you handle the
rephrasing. Warden's validation ensures technical content survives either way.

<!-- END WARDEN RULES -->

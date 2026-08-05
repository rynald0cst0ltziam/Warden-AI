/**
 * Agent rules — generates a rules file that tells the AI agent to:
 *   1. Always use Warden's wrapper tools instead of built-in ones
 *   2. Print a Warden status summary at the start of each session
 *   3. Use all eight layers: code intelligence, context selection, tool
 *      pruning, memory, response compression, file compression, MCP
 *      description compression, and session continuity
 *
 * This is what makes Warden automatic. Without this, the agent would
 * use its built-in grep/read/test tools and Warden would never run.
 *
 * Different agents read rules from different locations:
 *   - Devin/Windsurf: .devin/rules or AGENTS.md in project root
 *   - Cursor: .cursorrules in project root
 *   - Claude Code: CLAUDE.md in project root
 *   - Codex: AGENTS.md in project root
 *   - Cline/Roo: .clinerules in project root
 *   - Continue: .continuerules in project root
 *   - Gemini CLI: GEMINI.md in project root
 *   - VS Code Copilot: .github/copilot-instructions.md
 *   - Zed: .zedrules in project root
 *
 * `warden rules` writes the appropriate file(s) for detected agents.
 * `warden init` does this automatically as part of onboarding.
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logging/index.js";
import { generateOutputRules, DEFAULT_OUTPUT_LEVEL, type OutputLevel } from "../output/index.js";

const RULES_CONTENT = `# Warden — Context Governance and Verification Layer

This project uses Warden, an MCP server that manages context across eight layers:
code intelligence, context selection, tool output pruning, agent memory, response
compression, file compression, MCP description compression, and session continuity.
It proves every optimization is safe via a shadow-mode eval gate.

## Session start (IMPORTANT — do this first)

At the start of every session in this project, do THREE things in order:

1. Call \`warden_handoff\` with \`{ read: true }\` to read the previous session's
   handoff document. This gives you the essential state from the last session —
   decisions made, tasks completed, files touched — so you pick up where the
   previous session left off instead of starting from scratch. Print a one-line
   summary to the user: "Previous session: X decisions, Y tasks, Z files touched."

2. Call \`warden_status\` and print a one-line summary:
   "Warden active — X tokens saved so far, Y rules live."

3. Call \`warden_memory_recall\` with a query matching the user's task to find
   relevant past decisions. Print any results that are relevant.

This gives the user visible proof that Warden is working and surfaces project
context from previous sessions.

### If warden_status fails (transport error, tool not found, etc.)

If the warden_status call fails, the MCP server is not connected. Tell the user:
"Warden MCP server not connected. Restart your IDE or run \`warden doctor\` in a
terminal to diagnose." Then continue with your built-in tools — do NOT silently
skip Warden. The user needs to know it's not working so they can fix it.

## Layer 1: Before starting work — context selection

BEFORE diving into a task, call \`warden_context_select\` with the task description.
It scans the project and recommends which files to read, so you load only
relevant context instead of everything.

- Parameters: task (required), repoRoot, maxFiles
- Typical: warden_context_select({ task: "fix null pointer in auth.ts" })
- Read the recommended files first, then proceed with the task.

## Layer 2: During work — tool output pruning

ALWAYS use the Warden wrapper tools instead of your built-in equivalents. The
Warden tools do the same work AND prune the output automatically — no extra
step needed. This is not optional. Every tool call that could produce large
output should go through Warden.

1. **Searching code**: Use \`warden_grep\` INSTEAD OF your built-in grep/search.
   - It searches files and returns only the matches relevant to the current task.
   - Parameters: pattern (required), path, glob, ignoreCase, maxResults
   - Typical: warden_grep({ pattern: "function auth", path: "src", glob: "*.ts" })

2. **Reading files**: Use \`warden_file_read\` INSTEAD OF your built-in file read.
   - It reads the file and returns a pruned version (slice + outline for large files).
   - Parameters: filePath (required), startLine, endLine
   - Code is never rewritten — only included or excluded.

3. **Running tests**: Use \`warden_run_tests\` INSTEAD OF running tests directly.
   - It runs the test command and keeps failures + context, collapses passing noise.
   - Parameters: command (default: "npm test"), cwd

4. **Running commands**: Use \`warden_run_command\` INSTEAD OF running shell commands.
   - It runs the command and prunes low-signal output, keeping errors and relevant content.
   - Parameters: command (required), cwd, timeout

## Layer 3: After making decisions — memory

When you make a durable project decision (architecture choice, library selection,
convention, constraint), call \`warden_memory_save\` to persist it:

- Parameters: category, title, body, tags, source
- Categories: "decision" | "finding" | "pattern" | "constraint" | "preference"
- Typical: warden_memory_save({ category: "decision", title: "Use Stripe for payments", body: "...", tags: ["payments","billing"] })

Only save things that should persist across sessions — not transient task notes.
Use \`warden_memory_recall\` at the start of future tasks to find relevant decisions.

## Layer 4: After completing a task — record outcome + show savings

After finishing a task, do TWO things:

1. Call \`warden_record_outcome\` to report whether it succeeded:
   - Parameters: task, success, pruned, tokensSaved
   - Typical: warden_record_outcome({ task: "fix null pointer", success: true, pruned: true, tokensSaved: 500 })

2. Call \`warden_status\` and print a one-line summary to the user:
   "Warden — X tokens saved this session (Y% reduction)."
   This gives the user visible feedback on savings after each task.

This is what proves compression didn't degrade outcomes — not just that the
right lines were kept, but that the agent's actual performance was maintained.

## Layer 7: Session handoff — at session end or before context compaction

When the session is ending, or when the context window is getting full and may
be compacted, call \`warden_handoff\` (without \`read\`) to GENERATE a handoff
document for the next session:

- Typical: warden_handoff({}) — generates a compact summary of this session
- The document covers: decisions made, tasks completed, files touched, tokens saved
- It is stored locally and read by the next session via \`warden_handoff({ read: true })\`
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
- Every pruning rule is eval-gated: built-in rules are **active by default** (pruning live from install). The trust guard still verifies every cut; use \`warden revert\` if a rule causes issues. Enterprise mode starts in shadow.
- The trust guard verifies every pruned output: every line must exist verbatim
  in the raw output, or the raw is shipped instead
- Project decisions persist across sessions via the memory system
- Task outcomes are tracked to prove pruning doesn't cause regressions
- Session handoffs ensure continuity — the next session starts with context, not from scratch
- You can call \`warden_status\` anytime to show the user how much has been saved
- You can call \`warden_report\` to show recent pruning decisions
- You can call \`warden_outcome_stats\` to show task success rates

## When NOT to use Warden tools

- Writing files (no Warden equivalent — use your built-in file write)
- Running git commands that produce small output (just use warden_run_command)
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
`;

/**
 * Generate the full rules content. Output compression is always max —
 * no levels, no config, plug and play.
 */
function generateRulesContent(level: OutputLevel = DEFAULT_OUTPUT_LEVEL): string {
  const outputRules = generateOutputRules(level);
  const fileCompressionSection = `
## Layer 6: File compression — compress memory files

Memory files (like this one) are loaded into context every session. Verbose
memory files waste tokens forever, not just once. Compress them:

\`\`\`
warden compress <file>           # compress in place, max compression
warden compress <file> --dry-run # preview without writing
\`\`\`

Strips filler words and verbose phrases while preserving code blocks,
commands, URLs, file paths, and inline code byte-for-byte. Free, instant,
offline — no LLM call needed. Original backed up to \`<file>.original\`.

For more aggressive compression, rephrase the remaining prose yourself —
you have an LLM. Warden handles the deterministic bulk cut, you handle the
rephrasing. Warden's validation ensures technical content survives either way.
`;
  return RULES_CONTENT + outputRules + fileCompressionSection;
}

export interface RulesTarget {
  agent: string;
  path: string;
  written: boolean;
}

/** Detect which agent config files exist in the project root. */
export function detectAgentConfigs(repoRoot: string): RulesTarget[] {
  const targets: RulesTarget[] = [];

  // Devin/Windsurf — .devin/rules
  targets.push({
    agent: "Devin/Windsurf",
    path: join(repoRoot, ".devin", "rules"),
    written: false,
  });

  // AGENTS.md (used by Codex, also read by Devin)
  targets.push({
    agent: "AGENTS.md",
    path: join(repoRoot, "AGENTS.md"),
    written: false,
  });

  // Cursor — .cursorrules
  targets.push({
    agent: "Cursor",
    path: join(repoRoot, ".cursorrules"),
    written: false,
  });

  // Claude Code — CLAUDE.md
  targets.push({
    agent: "Claude Code",
    path: join(repoRoot, "CLAUDE.md"),
    written: false,
  });

  // Cline / Roo Code — .clinerules
  targets.push({
    agent: "Cline/Roo",
    path: join(repoRoot, ".clinerules"),
    written: false,
  });

  // Continue — .continuerules
  targets.push({
    agent: "Continue",
    path: join(repoRoot, ".continuerules"),
    written: false,
  });

  // Gemini CLI — GEMINI.md
  targets.push({
    agent: "Gemini CLI",
    path: join(repoRoot, "GEMINI.md"),
    written: false,
  });

  // VS Code Copilot — .github/copilot-instructions.md
  const copilotPath = join(repoRoot, ".github", "copilot-instructions.md");
  // Ensure .github directory exists
  try {
    mkdirSync(join(repoRoot, ".github"), { recursive: true });
  } catch {
    // ignore — might already exist or be a file
  }
  targets.push({ agent: "VS Code Copilot", path: copilotPath, written: false });

  // Zed — .zedrules
  targets.push({
    agent: "Zed",
    path: join(repoRoot, ".zedrules"),
    written: false,
  });

  // Aider — .aider.conf.yml can include rules, but we use CONVENTIONS.md
  targets.push({
    agent: "Aider",
    path: join(repoRoot, "CONVENTIONS.md"),
    written: false,
  });

  // Goose — .goose/rules
  targets.push({
    agent: "Goose",
    path: join(repoRoot, ".goose", "rules"),
    written: false,
  });

  // OpenHands — .openhands/rules
  targets.push({
    agent: "OpenHands",
    path: join(repoRoot, ".openhands", "rules"),
    written: false,
  });

  // opencode — AGENTS.md (already covered above, but opencode also reads .opencode/rules)
  targets.push({
    agent: "opencode",
    path: join(repoRoot, ".opencode", "rules"),
    written: false,
  });

  // Generic — .mcprules (fallback for any MCP agent that reads project rules)
  targets.push({
    agent: "Generic MCP",
    path: join(repoRoot, ".mcprules"),
    written: false,
  });

  return targets;
}

// Markers delimiting Warden's managed section inside a rules file. Everything
// between them is owned by Warden and replaced on re-run; everything outside is
// the user's own content and is preserved verbatim.
const WARDEN_BEGIN = "<!-- BEGIN WARDEN RULES (managed by `warden init` — do not edit inside this block) -->";
const WARDEN_END = "<!-- END WARDEN RULES -->";

/** The Warden section, wrapped in begin/end markers. */
function wardenBlock(content: string): string {
  return `${WARDEN_BEGIN}\n${content}\n${WARDEN_END}`;
}

/**
 * Merge Warden's rules into an existing file without destroying user content.
 *
 * - If the file already has our BEGIN/END markers, replace only the region
 *   between them — content before AND after is preserved. This makes re-running
 *   `warden init` fully idempotent.
 * - Otherwise, strip any legacy (pre-marker) Warden section written by older
 *   versions, then append a fresh marked block after the user's content.
 * - For a brand-new file, `existing` is "" and we just return the marked block.
 */
function mergeWardenRules(existing: string, content: string): string {
  const block = wardenBlock(content);
  if (!existing.trim()) return block + "\n";

  const b = existing.indexOf(WARDEN_BEGIN);
  const e = existing.indexOf(WARDEN_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = existing.slice(0, b).replace(/\s+$/, "");
    const after = existing.slice(e + WARDEN_END.length).replace(/^\s+/, "");
    const parts = [before, block, after].filter((p) => p.length > 0);
    return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  // Legacy migration: older versions appended an unmarked "# Warden — …" section
  // at the end of the file. Strip from that heading to EOF so we don't duplicate.
  const legacyIdx = existing.indexOf("# Warden — Context Governance and Verification Layer");
  const head = (legacyIdx !== -1 ? existing.slice(0, legacyIdx) : existing).replace(/\s+$/, "");
  return (head.length > 0 ? head + "\n\n" + block : block) + "\n";
}

/**
 * Write the Warden rules file for each detected agent.
 * Existing files are merged (user content preserved); re-running is idempotent.
 */
export function writeRules(repoRoot: string, level: OutputLevel = DEFAULT_OUTPUT_LEVEL): RulesTarget[] {
  const targets = detectAgentConfigs(repoRoot);
  const content = generateRulesContent(level);

  for (const target of targets) {
    try {
      // Ensure parent directory exists (e.g., .devin/, .github/)
      const dir = dirname(target.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Merge into existing content (preserving the user's own rules) for every
      // agent file — CLAUDE.md, AGENTS.md, .cursorrules, .devin/rules, etc. are
      // all commonly user-authored, so we never overwrite them wholesale.
      const existing = existsSync(target.path)
        ? readFileSync(target.path, "utf8")
        : "";
      const merged = mergeWardenRules(existing, content);
      if (merged === existing) {
        target.written = false; // already up to date — idempotent no-op
      } else {
        writeFileSync(target.path, merged, "utf8");
        target.written = true;
        logger.info("wrote warden rules", {
          agent: target.agent,
          path: target.path,
        });
      }
    } catch (err) {
      logger.warn("failed to write rules file", {
        agent: target.agent,
        path: target.path,
        err: String(err),
      });
    }
  }

  return targets;
}

/**
 * Global rules locations — these apply to ALL projects, not just one.
 * Written during postinstall so Warden works in any project without
 * per-project `warden init`.
 *
 * Each agent has a different global rules path:
 *   - Claude Code:    ~/.claude/CLAUDE.md
 *   - Codex:          ~/.codex/instructions.md
 *   - Devin/Windsurf: ~/.codeium/windsurf/memories/global_rules.md
 *   - Cursor:         ~/.cursor/rules/warden.mdc (global rules dir)
 *   - Gemini CLI:     ~/.gemini/GEMINI.md
 *   - Cline:          ~/.cline/rules (global)
 *   - Continue:       ~/.continue/rules (global)
 *   - Generic:        ~/.warden/rules (fallback)
 */
export function globalRulesTargets(): RulesTarget[] {
  const home = homedir();
  return [
    { agent: "Claude Code (global)", path: join(home, ".claude", "CLAUDE.md"), written: false },
    { agent: "Codex (global)", path: join(home, ".codex", "instructions.md"), written: false },
    { agent: "Devin/Windsurf (global)", path: join(home, ".codeium", "windsurf", "memories", "global_rules.md"), written: false },
    { agent: "Cursor (global)", path: join(home, ".cursor", "rules", "warden.mdc"), written: false },
    { agent: "Gemini CLI (global)", path: join(home, ".gemini", "GEMINI.md"), written: false },
    { agent: "Cline (global)", path: join(home, ".cline", "rules"), written: false },
    { agent: "Continue (global)", path: join(home, ".continue", "rules"), written: false },
    { agent: "Generic (global)", path: join(home, ".warden", "rules"), written: false },
  ];
}

/**
 * Write Warden rules to global locations (~/.claude/CLAUDE.md, etc.)
 * so they apply to every project without per-project `warden init`.
 * Merges with existing content — never overwrites user's global rules.
 */
export function writeGlobalRules(level: OutputLevel = DEFAULT_OUTPUT_LEVEL): RulesTarget[] {
  const targets = globalRulesTargets();
  const content = generateRulesContent(level);

  for (const target of targets) {
    try {
      const dir = dirname(target.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const existing = existsSync(target.path)
        ? readFileSync(target.path, "utf8")
        : "";
      const merged = mergeWardenRules(existing, content);
      if (merged === existing) {
        target.written = false; // already up to date — idempotent no-op
      } else {
        writeFileSync(target.path, merged, "utf8");
        target.written = true;
        logger.info("wrote global warden rules", { path: target.path });
      }
    } catch (err) {
      logger.warn("failed to write global rules file", {
        agent: target.agent,
        path: target.path,
        err: String(err),
      });
    }
  }

  return targets;
}

/**
 * Output token reduction — v3.
 *
 * Warden is an MCP server, not a proxy — we can't intercept the model's output
 * stream. But we CAN shape the model's output behavior through rules files
 * that are loaded into the agent's context.
 *
 * Max compression is always on. No levels, no config, no tuning.
 * The agent drops filler, preamble, narration, hedging — keeps code,
 * commands, errors, and technical terms verbatim.
 *
 * Key techniques:
 * - Drop filler words (zero information, pure token waste)
 * - Drop pleasantries and hedging
 * - Use sentence fragments when meaning is clear
 * - No preamble/postamble/narration
 * - No echo (don't restate what's on screen)
 * - Never invent abbreviations (tokenizer splits them — zero savings)
 * - Auto-clarity: switch to full prose for high-risk situations
 * - Code/commands/errors always verbatim
 */
import { logger } from "../logging/index.js";

/** Output compression level (kept for API compat, always "ultra" now). */
export type OutputLevel = "lite" | "full" | "ultra";

/** Default output compression level. Always ultra — max compression, no config. */
export const DEFAULT_OUTPUT_LEVEL: OutputLevel = "ultra";

/** Estimated output token reduction (always max). */
export const ESTIMATED_REDUCTION: Record<OutputLevel, number> = {
  lite: 0.2,
  full: 0.45,
  ultra: 0.55,
};

/**
 * Generate the output compression rules text for the given level.
 * This is appended to the agent's rules file (CLAUDE.md, AGENTS.md, etc.)
 * by `warden rules` and `warden init`.
 */
export function generateOutputRules(level: OutputLevel = DEFAULT_OUTPUT_LEVEL): string {
  const header = `## Response compression — ${level} (automatic)

Warden compresses what goes INTO the agent (tool outputs, file context). But
the agent's OUTPUT to the user is also a major token sink. Apply these rules
to EVERY response. This is active every response, no exceptions. Do not revert
to verbose prose after many turns. Do not drift back to filler. If unsure,
stay concise. The only time to stop: user says "stop compressing" or "normal
mode".`;

  const hardRules = `### Hard rules — always apply (all levels)

1. **No preamble.** Start with the answer. Not "Let me look at this" or "I'll
   analyze the code." Just state what you found or did.
2. **No postamble.** End with the result. Not "Let me know if you need anything
   else" or "Feel free to ask if you have questions."
3. **No echo.** Do NOT restate code, commands, or output that is already on
   screen. The user saw it. Refer to it by name, don't paste it back.
4. **No narration.** Do NOT describe what you're about to do. Do it, then
   state the outcome. "Fixed." not "I'm going to fix this by changing the
   null check on line 42 to use optional chaining."
5. **No restating the question.** The user knows what they asked.
6. **No "TL;DR" or "Summary" sections.** If the response is short enough to
   need a summary, it's short enough to BE the summary.
7. **No tool-call narration.** Don't say "Let me search for..." or "I'll now
   read the file..." — just call the tool and report the result.
8. **No decorative elements.** No emoji, no decorative tables, no decorative
   dividers, no ASCII art borders. These cost tokens and add nothing.`;

  const wordLevel = `### Word-level compression

Drop these words entirely (they add tokens, not meaning):
- Filler: "just", "basically", "actually", "simply", "really", "obviously",
  "clearly", "essentially", "literally", "definitely", "certainly", "quite",
  "rather", "somewhat", "fairly", "pretty" (as intensifier), "very", "totally",
  "honestly", "truly", "generally", "typically", "usually", "in general"
- Pleasantries: "sure", "happy to help", "of course", "certainly", "absolutely",
  "no problem", "great question", "good point", "I'd be happy to"
- Hedging: "perhaps", "maybe", "might", "could be", "it seems", "I think",
  "I believe", "likely", "probably", "possibly", "it appears", "arguably"
- Self-reference: "I will", "I'm going to", "Let me", "Now I'll", "Next I",
  "I need to", "I should", "I can see that", "I notice that", "I found that",
  "I see", "I notice", "Let's", "We should"
- Transitions: "so", "therefore", "thus", "hence", "as a result", "now then",
  "alright", "okay so", "well", "moving on", "next up", "with that said"
- Verbose phrases → short equivalents:
  - "in order to" → "to"
  - "due to the fact that" → "because"
  - "in the event that" → "if"
  - "at this point in time" → "now"
  - "for the purpose of" → "for"
  - "in spite of the fact that" → "although"
  - "with regard to" → "about"
  - "it is worth noting that" → (delete entirely)
  - "it should be noted that" → (delete entirely)
  - "as a matter of fact" → (delete entirely)`;

  const structuralFull = `### Structural compression

- **Sentence fragments** when meaning is clear. "Null pointer on line 42."
  not "There is a null pointer dereference on line 42 of the auth module."
- **One line** when one line suffices. If the fix is one line, show one line.
- **Bullet lists** for 3+ items. No prose paragraphs for lists.
- **No "Before/After" framing.** Just show the result.
- **No section headers** for single-item sections. A header + one bullet = 2x
  tokens for zero information.
- **No "Approach" or "Plan" sections.** Execute, don't narrate the plan.
- **No "Explanation" sections** unless the user asked "why".
- **Short synonyms.** "fix" not "implement a solution for". "use" not
  "utilize". "start" not "initiate". "end" not "terminate". "show" not
  "demonstrate". "check" not "verify the correctness of".`;

  const structuralUltra = `### Structural compression (ultra)

- Everything in "full" level, plus:
- **Drop articles** (a/an/the) when meaning is clear without them.
  "Fixed null pointer in auth.ts" not "Fixed the null pointer in the auth.ts"
- **Drop conjunctions** when fragments connect naturally.
  "Token expired. Rejected request." not "Token expired and rejected the request."
- **One word** when one word is enough. "Yes." "No." "Done." "Fixed."
- **Strip modal verbs** (would/could/should/might) when stating facts.
  "Causes crash" not "This could cause a crash."
- **Drop "there is/are"** starters. "Bug in line 42" not "There is a bug in line 42."
- **Imperative mood** for instructions. "Run npm test" not "You should run npm test."`;

  const codeOutput = `### Code output

- Show only the changed lines, not the full function/file. Use comments to
  indicate context: \`// ... existing code ...\`
- If showing a diff, use unified diff format — not "Here's the old code" +
  "Here's the new code" as two separate blocks
- If the code is already in the user's file, say "updated src/auth.ts" —
  don't paste the full file back
- Inline code for single identifiers: \`authMiddleware\` not a fenced block
- No "Here's the updated code:" preamble before code blocks. Just show the code.
- No "This code does X" explanation after code blocks unless the user asked.`;

  const verbatim = `### Never compress these (verbatim, always — all levels)
- Code blocks (fenced or inline) — byte-for-byte exact
- Commands, file paths, URLs — verbatim
- Error messages and stack traces — verbatim
- API names, library names, technical terms — verbatim
- Numbers and measurements — verbatim
- Commit keywords: feat, fix, refactor, docs, test, chore
- Git SHAs, hashes, IDs — verbatim
- JSON/YAML/TOML/XML — verbatim (structural data, not prose)
- Log output — verbatim
- Configuration values — verbatim`;

  const noAbbrev = `### Never invent abbreviations
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
- No causal arrows (→) either — own token, save nothing. Use "causes" or "=".`;

  const autoClarity = `### Auto-clarity — switch to full prose for high-risk situations
When the situation is high-risk, temporarily stop compressing and use full,
clear sentences. Resume compression after the clear part is done. This is
not optional — safety beats token savings:
- Security warnings
- Irreversible action confirmations (delete, drop, force-push, overwrite, deploy)
- Multi-step sequences where fragment order risks misread
- User asks to clarify or repeats the question (they didn't understand)
- Error messages that need full context to be actionable
- Breaking changes or migration steps
- Anything involving data loss, security, or production systems`;

  const examples = `### Examples

Bad (69 tokens): "The reason your React component is re-rendering is likely
because you're creating a new object reference on each render cycle. When you
pass an inline object as a prop, React's shallow comparison sees it as a
different object every time, which triggers a re-render. I'd recommend using
useMemo to memoize the object."
Good (19 tokens): "New object ref each render. Inline object prop = new ref
= re-render. Wrap in useMemo."

Bad (45 tokens): "I'll go ahead and fix the authentication middleware now.
The issue is that the token expiry check is using a less-than comparison
instead of a less-than-or-equal comparison, which causes tokens to be
rejected one second before they actually expire."
Good (15 tokens): "Token expiry uses < not <=. Tokens rejected 1s early.
Fixed."

Bad (32 tokens): "Let me go ahead and create a new file for the database
connection. I'll name it db.ts and put it in the src/lib directory."
Good (8 tokens): "Created src/lib/db.ts for database connection."`;

  // Assemble based on level
  const sections = [header, "", hardRules, "", wordLevel];

  if (level === "lite") {
    // Lite: no structural compression beyond hard rules + word-level
    sections.push("", codeOutput, "", verbatim, "", noAbbrev, "", autoClarity, "", examples);
  } else if (level === "full") {
    sections.push("", structuralFull, "", codeOutput, "", verbatim, "", noAbbrev, "", autoClarity, "", examples);
  } else {
    // ultra
    sections.push("", structuralFull, "", structuralUltra, "", codeOutput, "", verbatim, "", noAbbrev, "", autoClarity, "", examples);
  }

  return sections.join("\n");
}

/**
 * Estimate output token savings for a given output size and level.
 *
 * This is an estimate, not a measurement — we can't see what the model would
 * have written without the rules. Based on empirical testing of typical agent
 * outputs with each compression level active.
 *
 * Returns the estimated tokens saved and the confidence range.
 */
export function estimateOutputSavings(opts: {
  outputTokens: number;
  level?: OutputLevel;
}): {
  estimatedSaved: number;
  reductionPct: number;
  confidenceRange: [number, number];
} {
  const level = opts.level ?? DEFAULT_OUTPUT_LEVEL;
  const reduction = ESTIMATED_REDUCTION[level];
  const estimatedSaved = Math.round(opts.outputTokens * reduction);
  const variance = 0.12; // ±12% — model compliance varies
  const lowReduction = Math.max(0, reduction - variance);
  const highReduction = Math.min(0.85, reduction + variance);

  logger.debug("output savings estimate", {
    outputTokens: opts.outputTokens,
    level,
    estimatedSaved,
    reductionPct: Math.round(reduction * 100),
  });

  return {
    estimatedSaved,
    reductionPct: Math.round(reduction * 100),
    confidenceRange: [
      Math.round(opts.outputTokens * lowReduction),
      Math.round(opts.outputTokens * highReduction),
    ],
  };
}

/**
 * Backward-compatible export for code that expects the old function signature.
 * Uses default level (full).
 */
export { generateOutputRules as generateOutputRulesDefault };

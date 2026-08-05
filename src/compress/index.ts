/**
 * Deterministic file compression — v2.
 *
 * Improved based on research of Caveman, mdcompress, ContextCompressionEngine,
 * tokenshrink, and Terse.ai:
 *
 * - Multi-pass sentinel restoration (fixes caveman-shrink's nesting bug #444)
 * - Sentence restructuring (not just word stripping — collapses multi-clause
 *   sentences into fragments)
 * - Inline code validation (caveman misses this — issue #112)
 * - No abbreviations (measured zero token savings under BPE, per tokenshrink)
 * - Article removal in ultra mode (biggest single win after filler)
 * - Heading preservation (caveman validates this, we should too)
 * - Bullet hierarchy preservation
 *
 * Three levels:
 *   lite  — drop filler/hedging, keep full sentences (~10-15%)
 *   full  — also drop articles, fragments OK, collapse verbose phrases (~20-30%)
 *   ultra — also strip conjunctions, modal verbs, "there is/are", drop low-value sentences (~30-40%)
 */

export interface CompressResult {
  original: string;
  compressed: string;
  tokensBefore: number;
  tokensAfter: number;
  reductionPct: number;
  preservedSegments: number;
  validationOk: boolean;
  validationErrors: string[];
}

export type CompressLevel = "lite" | "full" | "ultra";

/** Rough token estimate (~4 chars/token, close to cl100k_base average). */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ---------------------------------------------------------------------------
// Protected segments — technical content that must survive verbatim
//
// Uses a sentinel format that won't collide with prose: \x00P000\x00
// Multi-pass restoration handles nested patterns (caveman-shrink bug #444).
// ---------------------------------------------------------------------------

export interface ProtectedSegment {
  sentinel: string;
  content: string;
}

const SENTINEL_OPEN = "wprdsentinel";
const SENTINEL_CLOSE = "sentinelwprd";

function makeSentinel(n: number): string {
  return `${SENTINEL_OPEN}${n}${SENTINEL_CLOSE}`;
}

const SENTINEL_RE = /wprdsentinel(\d+)sentinelwprd/g;

/** Extract technical content and replace with sentinels. */
export function protectSegments(text: string): {
  text: string;
  segments: ProtectedSegment[];
} {
  const segments: ProtectedSegment[] = [];
  let counter = 0;

  const protect = (content: string): string => {
    const sentinel = makeSentinel(counter);
    // Resolve any existing sentinels in the content before storing, so
    // validation checks against the original text, not intermediate forms.
    // This handles nested protection (e.g., URLs inside markdown links).
    const resolved = content.replace(SENTINEL_RE, (_m, idx) => {
      const existing = segments[Number(idx)];
      return existing ? existing.content : _m;
    });
    segments.push({ sentinel, content: resolved });
    counter++;
    return sentinel;
  };

  let result = text;

  // 0. Markdown headings — protect FIRST so no other regex touches them
  result = result.replace(/^#{1,6}\s+.+$/gm, (m) => protect(m));

  // 1. Fenced code blocks (```...``` or ~~~...~~~), including nested (4+ backticks)
  //    Match from opening fence to closing fence of same length.
  result = result.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (m) => protect(m));

  // 2. Indented code blocks (4+ spaces, not in a list item)
  result = result.replace(/^(    +[^\n]*\n?)+/gm, (m) => protect(m));

  // 3. Inline code (`...`) — including multi-backtick inline ``...``
  result = result.replace(/(`{2,})[^`\n]+?\1/g, (m) => protect(m));
  result = result.replace(/`[^`\n]+`/g, (m) => protect(m));

  // 4. URLs (http/https)
  result = result.replace(/https?:\/\/[^\s)<>"']+/g, (m) => protect(m));

  // 5. Markdown links [text](url) — protect the whole thing
  result = result.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m) => protect(m));

  // 6. File paths (must contain / or \ and look like a path)
  result = result.replace(
    /(?:^|[\s(])((?:\.\/|\.\\|\.\.\/|\.\.\\|\/|\\|[A-Za-z]:\\)[A-Za-z0-9._\-\\\/]+|[A-Za-z0-9_.\-]+[\/\\][A-Za-z0-9_.\-\\\/]+)/g,
    (m, _g1) => protect(m),
  );

  // 7. Commands (lines starting with $ or known CLI tools)
  result = result.replace(
    /^(?:\$|npm |yarn |pnpm |npx |git |docker |kubectl |pip |cargo |go |make |brew |apt |choco |winget |rustup |node |python |ruby )+.*$/gm,
    (m) => protect(m),
  );

  // 8. Environment variables ($VAR, ${VAR}, %VAR%)
  result = result.replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, (m) => protect(m));
  result = result.replace(/%[A-Z_][A-Z0-9_]*%/g, (m) => protect(m));

  // 9. Version numbers (1.2.3, v1.2.3, >=1.2.3, ^1.2.3)
  result = result.replace(/[<>^~]?=?\s*v?\d+\.\d+\.\d+/g, (m) =>
    protect(m.trim()),
  );

  // 10. CamelCase / PascalCase / snake_case / SCREAMING_SNAKE identifiers
  //     (protect so we don't accidentally strip words from inside them)
  result = result.replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, (m) =>
    protect(m),
  );
  result = result.replace(/\b[A-Z_]{3,}[A-Z0-9_]*\b/g, (m) => protect(m));

  return { text: result, segments };
}

/** Restore protected segments with multi-pass handling for nested patterns. */
export function restoreSegments(
  text: string,
  segments: ProtectedSegment[],
): string {
  let result = text;
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let found = false;
    result = result.replace(SENTINEL_RE, (_match, idx) => {
      found = true;
      const seg = segments[parseInt(idx, 10)];
      return seg ? seg.content : _match;
    });
    if (!found) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation — check that all protected segments survived
// ---------------------------------------------------------------------------

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateSegments(
  compressed: string,
  segments: ProtectedSegment[],
): ValidationResult {
  const errors: string[] = [];
  for (const seg of segments) {
    if (!compressed.includes(seg.content)) {
      const preview =
        seg.content.length > 80
          ? seg.content.slice(0, 80) + "..."
          : seg.content;
      errors.push(`Protected segment lost: ${preview}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Validate markdown structure — headings, bullet counts preserved. */
function validateStructure(
  original: string,
  compressed: string,
): ValidationResult {
  const errors: string[] = [];

  // Check heading count and text
  const origHeadings = original.match(/^#{1,6}\s+.+$/gm) ?? [];
  const compHeadings = compressed.match(/^#{1,6}\s+.+$/gm) ?? [];
  if (origHeadings.length !== compHeadings.length) {
    errors.push(
      `Heading count mismatch: ${origHeadings.length} → ${compHeadings.length}`,
    );
  } else {
    for (let i = 0; i < origHeadings.length; i++) {
      if (origHeadings[i] !== compHeadings[i]) {
        errors.push(
          `Heading ${i + 1} changed: "${origHeadings[i]}" → "${compHeadings[i]}"`,
        );
      }
    }
  }

  // Check that no fenced code block was lost
  const origBlocks = original.match(/(`{3,}|~{3,})[\s\S]*?\1/g) ?? [];
  const compBlocks = compressed.match(/(`{3,}|~{3,})[\s\S]*?\1/g) ?? [];
  if (origBlocks.length !== compBlocks.length) {
    errors.push(
      `Code block count mismatch: ${origBlocks.length} → ${compBlocks.length}`,
    );
  } else {
    for (let i = 0; i < origBlocks.length; i++) {
      if (origBlocks[i] !== compBlocks[i]) {
        errors.push(`Code block ${i + 1} content changed`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Compression transformations
// ---------------------------------------------------------------------------

/** Filler words to remove entirely. */
const FILLER_WORDS = [
  "basically",
  "actually",
  "simply",
  "really",
  "very",
  "quite",
  "just",
  "obviously",
  "clearly",
  "essentially",
  "generally",
  "literally",
  "totally",
  "honestly",
  "truly",
  "certainly",
  "definitely",
  "absolutely",
  "of course",
  "needless to say",
  "it goes without saying",
  "as a matter of fact",
  "in fact",
  "to be honest",
  "to be fair",
  "at the end of the day",
  "when all is said and done",
];

/** Verbose phrases → shorter equivalents. */
const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bin the event that\b/gi, "if"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bwith regard to\b/gi, "about"],
  [/\bwith reference to\b/gi, "about"],
  [/\bin reference to\b/gi, "about"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bin the process of\b/gi, "while"],
  [/\ba number of\b/gi, "several"],
  [/\bthe majority of\b/gi, "most"],
  [/\ba large number of\b/gi, "many"],
  [/\bin all likelihood\b/gi, "probably"],
  [/\bit is worth noting that\b/gi, ""],
  [/\bit should be noted that\b/gi, ""],
  [/\bit is important to note that\b/gi, ""],
  [/\bplease note that\b/gi, ""],
  [/\bas previously mentioned\b/gi, ""],
  [/\bas stated above\b/gi, ""],
  [/\bas discussed earlier\b/gi, ""],
  [/\bgoing forward\b/gi, ""],
  [/\bat this point in time\b/gi, "now"],
  [/\bat the present time\b/gi, "now"],
  [/\bin the near future\b/gi, "soon"],
  [/\bfor the time being\b/gi, "temporarily"],
  [/\bin the absence of\b/gi, "without"],
  [/\btake into consideration\b/gi, "consider"],
  [/\bmake use of\b/gi, "use"],
  [/\bgive consideration to\b/gi, "consider"],
  [/\bare able to\b/gi, "can"],
  [/\bis able to\b/gi, "can"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bin a timely manner\b/gi, "promptly"],
  [/\bon a regular basis\b/gi, "regularly"],
  [/\bon a daily basis\b/gi, "daily"],
  [/\bon a weekly basis\b/gi, "weekly"],
  [/\bin most cases\b/gi, "usually"],
  [/\bin some cases\b/gi, "sometimes"],
  [/\bin general\b/gi, ""],
  [/\bgenerally speaking\b/gi, ""],
  [/\bfor the most part\b/gi, ""],
  [/\bit is recommended to\b/gi, ""],
  [/\bit is recommended that\b/gi, ""],
  [/\bfor more information[,.]?\s*/gi, ""],
  [/\bsee below\b/gi, ""],
  [/\bsee above\b/gi, ""],
  [/\bmake sure to\b/gi, "ensure"],
  [/\bmake sure that\b/gi, "ensure"],
  [/\bthe reason is because\b/gi, "because"],
  [/\bthe reason for this is that\b/gi, "because"],
  // mdcompress-inspired rules
  [/\bit should be mentioned that\b/gi, ""],
  [/\bit should be pointed out that\b/gi, ""],
  [/\bas you might expect\b/gi, ""],
  [/\bas you can see\b/gi, ""],
  [/\bas you may know\b/gi, ""],
  [/\bit goes without saying that\b/gi, ""],
  [/\bfor those who are unfamiliar\b/gi, ""],
  [/\bif you are not familiar with\b/gi, ""],
  [/\bas a general rule\b/gi, ""],
  [/\bas a rule of thumb\b/gi, ""],
  [/\bas the name suggests\b/gi, ""],
  [/\bneedless to say[,]?\s*/gi, ""],
  [/\bnot to mention\b/gi, ""],
  [/\bto put it simply\b/gi, ""],
  [/\bto put it bluntly\b/gi, ""],
  [/\bwith that in mind\b/gi, ""],
  [/\bwith that said\b/gi, ""],
  [/\bhaving said that\b/gi, ""],
  [/\bthat being said\b/gi, ""],
  [/\bin other words\b/gi, ""],
  [/\bto reiterate\b/gi, ""],
  [/\bto summarize\b/gi, ""],
  [/\bin conclusion\b/gi, ""],
  [/\bas a result\b/gi, ""],
  [/\bas such\b/gi, ""],
  [/\bin particular\b/gi, ""],
  [/\bon the other hand\b/gi, ""],
  [/\bfirst and foremost\b/gi, ""],
  [/\blast but not least\b/gi, ""],
  // mdcompress admonition prefixes
  [/^\*\*note:\*\*\s*/gim, ""],
  [/^\*\*warning:\*\*\s*/gim, ""],
  [/^\*\*tip:\*\*\s*/gim, ""],
  [/^\*\*important:\*\*\s*/gim, ""],
  [/^\*\*caution:\*\*\s*/gim, ""],
  // Cross-references
  [/\bsee the\s+\[[^\]]+\]\s+section for (?:details|more information)\b/gi, ""],
  [/\bsee (?:the )?(?:above|below) (?:section|table|diagram|example)\b/gi, ""],
  [/\brefer to (?:the )?(?:documentation|manual|guide|readme)\b/gi, ""],
];

/** Pleasantries to strip from line starts. */
const PLEASANTRIES = [
  /^(sure|certainly|absolutely|definitely|of course|great question|good question|happy to help|i'd be happy to help|let me take a look|let me check that|let me see|let me think about that)[!.]?\s*/gi,
  /^(i will|i'll|i'm going to|let me|i am going to)\s+/gi,
  /^(i think|i believe|i feel|i guess|i suppose|i would say)\s+/gi,
];

/** Connective fluff to remove. */
const CONNECTIVE_FLUFF = [
  /\bhowever[,:]?\s*/gi,
  /\bfurthermore[,:]?\s*/gi,
  /\bmoreover[,:]?\s*/gi,
  /\badditionally[,:]?\s*/gi,
  [/\bin addition\b/gi, ""],
  [/\bon the other hand\b/gi, ""],
  [/\bthat being said\b/gi, ""],
  [/\bwith that being said\b/gi, ""],
  [/\bneedless to say\b/gi, ""],
];

/** Strip filler words and verbose phrases from prose. */
export function stripFiller(text: string, level: CompressLevel): string {
  let result = text;

  // 1. Remove filler words
  for (const word of FILLER_WORDS) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  }

  // 2. Apply phrase replacements
  for (const [re, replacement] of PHRASE_REPLACEMENTS) {
    result = result.replace(re, replacement);
  }

  // 3. Strip pleasantries from line starts
  for (const re of PLEASANTRIES) {
    result = result.replace(re, "");
  }

  // 4. Remove connective fluff (full and ultra)
  if (level === "full" || level === "ultra") {
    for (const pattern of CONNECTIVE_FLUFF) {
      if (pattern instanceof RegExp) {
        result = result.replace(pattern, "");
      }
    }
  }

  // 5. Full level: drop "you should/can/need", "it is important to", etc.
  if (level === "full" || level === "ultra") {
    result = result.replace(
      /\byou (should|can|need to|may|must|will|will need to)\s+/gi,
      "",
    );
    result = result.replace(/\bit is (important|worth|necessary) to\s+/gi, "");
    result = result.replace(/\bplease\s+/gi, "");
    result = result.replace(/^note that\s+/gim, "");
    result = result.replace(/\bthe following\s+/gi, "");
    result = result.replace(/\byou can (use|run|call|see|find)\s+/gi, "$1 ");
    result = result.replace(/\byou should (use|run|call|see|find)\s+/gi, "$1 ");
    result = result.replace(/\bthe `([^`]+)`/g, "`$1");
  }

  // 6. Ultra level: drop articles, conjunctions, modal verbs, second person
  if (level === "ultra") {
    // Strip "should be" / "must be" / "will be" as a unit (avoids leaving "be")
    result = result.replace(/\b(should|must|will|can|may|might)\s+be\s+/gi, "");
    // Strip remaining modal verbs
    result = result.replace(/\b(should|must|will|can|may|might)\s+/gi, "");

    // Drop "you" / "your" / "yours" / "yourself" (second person is filler in docs)
    result = result.replace(/\b(you|your|yours|yourself)\s+/gi, "");

    // Drop articles (a, an, the) — biggest single win after filler
    // Don't drop at sentence/line start to preserve readability
    result = result.replace(/\b(a|an|the)\b/gi, (m, _word, offset) => {
      if (offset === 0) return m;
      const before = result[offset - 1];
      if (
        before === "\n" ||
        before === "." ||
        before === "!" ||
        before === "?"
      ) {
        return m;
      }
      return "";
    });

    // Collapse "there is/are" → ""
    result = result.replace(/\bthere (is|are)\s+/gi, "");

    // Remove "that" as conjunction
    result = result.replace(/\sthat\s+(?=[a-z])/gi, " ");

    // Remove "it is/was" at sentence start
    result = result.replace(/^it (is|was)\s+/gim, "");

    // Remove "is going to"
    result = result.replace(/\bis going to\s+/gi, "");

    // Collapse "is/are X" → "X" at sentence start (e.g., "are organized" → "organized")
    result = result.replace(/^(are|is)\s+/gim, "");

    // Strip "also" (filler connective)
    result = result.replace(/\balso\s+/gi, "");
  }

  return result;
}

/** Collapse multi-clause sentences into fragments. */
export function fragmentSentences(text: string, level: CompressLevel): string {
  if (level === "lite") return text;

  let result = text;

  // "X because Y" → "X. Y" (shorter, same meaning)
  result = result.replace(/\s+because\s+/g, ". ");

  // "X so that Y" → "X. Y"
  result = result.replace(/\s+so that\s+/g, ". ");

  // "X which means Y" → "X. Y"
  result = result.replace(/,\s*which means\s+/g, ". ");

  // "X, for example, Y" → "X. E.g. Y"
  result = result.replace(/,\s*for example,?\s*/g, ". E.g. ");

  // "X, such as Y" → "X: Y"
  result = result.replace(/,\s*such as\s+/g, ": ");

  // "X, including Y" → "X: Y"
  result = result.replace(/,\s*including\s+/g, ": ");

  // Remove "which is/are" clauses (often redundant)
  result = result.replace(/,\s*which (is|are)\s+[^.]+?\./g, ".");

  // Full and ultra: more aggressive restructuring
  if (level === "full" || level === "ultra") {
    // "It is worth noting that X" → "X" (already partially handled, but catch remnants)
    result = result.replace(/^worth noting that\s+/gim, "");

    // "It is recommended that X" → "X"
    result = result.replace(/^recommended that\s+/gim, "");

    // "It is important to X" → "X"
    result = result.replace(/^important to\s+/gim, "");

    // "Note: X" → "X" (drop the note prefix)
    result = result.replace(/^note:\s+/gim, "");

    // "Note that X" → "X"
    result = result.replace(/^note that\s+/gim, "");

    // "Please note that X" → "X"
    result = result.replace(/^please note that\s+/gim, "");

    // "In addition, X" → "X"
    result = result.replace(/^in addition,?\s+/gim, "");

    // "Furthermore, X" → "X"
    result = result.replace(/^furthermore,?\s+/gim, "");

    // "Moreover, X" → "X"
    result = result.replace(/^moreover,?\s+/gim, "");

    // "However, X" → "X"
    result = result.replace(/^however,?\s+/gim, "");

    // "At the end of the day, X" → "X"
    result = result.replace(/^at end of day,?\s+/gim, "");

    // Collapse "The project uses X" → "Uses X" (drop "The project" when obvious)
    result = result.replace(/^the project\s+/gim, "");
    result = result.replace(/\bthe project\s+/gi, "");

    // "This is a X" → "X" (drop "This is a")
    result = result.replace(/^this is a\s+/gim, "");
    result = result.replace(/^this is an\s+/gim, "");
    result = result.replace(/^this is\s+/gim, "");
  }

  // Ultra: even more aggressive
  if (level === "ultra") {
    // Collapse "X, as it contains Y" → "X. Y"
    result = result.replace(/,\s*as it contains\s+/g, ". ");

    // Collapse "X, as it Y" → "X. Y"
    result = result.replace(/,\s*as it\s+/g, ". ");

    // Drop "just make sure to" → ""
    result = result.replace(/\bjust make sure to\s+/gi, "");

    // "you should be good to go" → ""
    result = result.replace(/\bshould be good to go[.]?\s*/gi, "");

    // "and you should be good to go" → ""
    result = result.replace(/\band should be good to go[.]?\s*/gi, "");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sentence scoring — drop low-value sentences in ultra mode
// ---------------------------------------------------------------------------

/**
 * Score a sentence by how much technical information it carries.
 *
 * Inspired by ContextCompressionEngine's scoring algorithm:
 * - +3 per camelCase / PascalCase / snake_case identifier
 * - +4 for emphasis words (importantly, however, critical, must, never, always)
 * - +2 per number with units (10 seconds, 500 MB, 2.5.1)
 * - +2 per vowelless abbreviation (npm, ssh, api, sql, cli)
 * - +3 per status word (PASS, FAIL, ERROR, WARNING, TODO, FIXME)
 * - +2 per file path or grep-style reference (src/foo.ts:42:)
 * - +2 for optimal length (40-120 chars — substantive content)
 * - -10 for filler starters (great, sure, ok, thanks, please, hopefully)
 * - -5 for very short sentences (< 15 chars — usually fragments)
 *
 * Sentences with score <= 0 are candidates for removal in ultra mode.
 */
export function scoreSentence(sentence: string): number {
  const s = sentence.trim();
  if (!s) return -100;

  let score = 0;

  // camelCase / PascalCase / snake_case identifiers
  const identifiers = s.match(
    /\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+_[a-z_]+\b/g,
  );
  if (identifiers) score += identifiers.length * 3;

  // SCREAMING_SNAKE identifiers
  const screaming = s.match(/\b[A-Z_]{3,}[A-Z0-9_]*\b/g);
  if (screaming) score += screaming.length * 3;

  // Emphasis words
  const emphasis = s.match(
    /\b(importantly|however|critical|crucial|must|never|always|required|mandatory|essential|vital|warning|danger|security|irreversible)\b/gi,
  );
  if (emphasis) score += emphasis.length * 4;

  // Numbers with units
  const numbers = s.match(
    /\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|MB|GB|KB|bytes?|ms|tokens?|lines?|files?|times?|iterations?|requests?|errors?|warnings?|tests?|version|v)\b/gi,
  );
  if (numbers) score += numbers.length * 2;

  // Version numbers (e.g., 2.5.1, 1.0.0)
  const versions = s.match(/\b\d+\.\d+(?:\.\d+)?\b/g);
  if (versions) score += versions.length * 2;

  // Vowelless abbreviations (3+ consonants, no vowels)
  const abbrevs = s.match(/\b[b-df-hj-np-tv-z]{3,}\b/gi);
  if (abbrevs) score += abbrevs.length * 2;

  // Status words
  const status = s.match(
    /\b(PASS|FAIL|ERROR|WARNING|WARN|TODO|FIXME|HACK|NOTE|BUG|FIX)\b/g,
  );
  if (status) score += status.length * 3;

  // File paths or grep-style references
  const paths = s.match(/\b[\w-]+\/[\w./-]+:\d+:/g);
  if (paths) score += paths.length * 2;

  // Optimal length (substantive content)
  if (s.length >= 40 && s.length <= 120) score += 2;

  // Wordiness penalty — very long sentences are usually verbose
  if (s.length > 150) score -= 5;
  if (s.length > 200) score -= 5;

  // Filler starters (heavy penalty)
  const fillerStart = s.match(
    /^(great|sure|ok|okay|thanks|thank you|please|hopefully|ideally|luckily|fortunately|unfortunately|needless to say|of course|certainly|definitely|absolutely)\b/i,
  );
  if (fillerStart) score -= 10;

  // Very short sentences (usually fragments with no value after filler removal)
  if (s.length < 15) score -= 5;

  // Common word ratio — sentences full of common words carry less info
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 10) {
    const commonWords = words.filter((w) =>
      /\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|can|that|this|these|those|it|its|they|them|their|there|here|where|when|what|which|who|whom|and|but|or|not|no|so|if|then|than|also|just|very|more|most|some|any|all|each|every|other|such|only|own|same|too|one|two)\b/i.test(
        w,
      ),
    );
    const commonRatio = commonWords.length / words.length;
    if (commonRatio > 0.6) score -= 3;
  }

  return score;
}

/**
 * Drop low-value sentences from prose paragraphs in ultra mode.
 *
 * Splits each paragraph into sentences, scores them, and drops sentences
 * with score <= 0. Keeps at least one sentence per paragraph (the highest-
 * scored one) so we never produce empty paragraphs.
 *
 * This is the technique that gets ContextCompressionEngine from 25% to 48%.
 */
export function dropLowValueSentences(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const result: string[] = [];

  for (const para of paragraphs) {
    // Don't touch non-prose lines (headings, code, lists, tables)
    const trimmed = para.trim();
    if (!trimmed) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith("#")) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith("```")) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith("|")) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith(">")) {
      result.push(para);
      continue;
    }
    if (trimmed.startsWith("wprdsentinel")) {
      result.push(para);
      continue;
    }

    // Split into sentences
    const sentences = para.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    if (sentences.length <= 1) {
      result.push(para);
      continue;
    }

    // Score each sentence
    const scored = sentences.map((s) => ({
      sentence: s,
      score: scoreSentence(s),
      hasSentinel: /wprdsentinel\d+sentinelwprd/.test(s),
    }));

    // Keep sentences with score >= 5 (substantive technical content),
    // sentences with sentinels (protected content), and always keep the
    // best one per paragraph so we never produce empty paragraphs.
    const best = scored.reduce((a, b) => (a.score > b.score ? a : b));
    const kept = scored.filter(
      (s) => s.score >= 5 || s.hasSentinel || s === best,
    );

    if (kept.length === 0) {
      result.push(para);
      continue;
    }

    // Join with newlines if any sentence contains a sentinel (protected content
    // like headings must stay on their own line to preserve markdown structure).
    const hasAnySentinel = kept.some((s) => s.hasSentinel);
    const joinChar = hasAnySentinel ? "\n" : " ";
    result.push(kept.map((s) => s.sentence).join(joinChar));
  }

  return result.join("\n\n");
}

/** Clean up whitespace after transformations — preserve markdown structure. */
export function cleanupWhitespace(text: string): string {
  let result = text;

  // Collapse multiple spaces (but not newlines)
  result = result.replace(/[ \t]{2,}/g, " ");

  // Fix spacing around punctuation
  result = result.replace(/ ([,;:!?])/g, "$1");
  result = result.replace(/([,;:!?])(?=[A-Za-z])/g, "$1 ");

  // Remove empty sentences (leftover after removing filler)
  result = result.replace(/\.\s*\.\s*/g, ". ");
  result = result.replace(/^\s*[.\s]*$/gm, "");

  // Remove trailing whitespace per line
  result = result.replace(/[ \t]+$/gm, "");

  // Collapse 3+ blank lines to 2
  result = result.replace(/\n{3,}/g, "\n\n");

  // Remove leading blank lines
  result = result.replace(/^\n+/, "");

  // Ensure file ends with single newline
  result = result.replace(/\n+$/, "\n");

  return result;
}

// ---------------------------------------------------------------------------
// Main compression function
// ---------------------------------------------------------------------------

export function compressFile(
  content: string,
  level: CompressLevel = "full",
): CompressResult {
  const tokensBefore = approxTokens(content);

  // 1. Protect technical content
  const { text: protected_, segments } = protectSegments(content);

  // 2. Strip filler from prose
  const stripped = stripFiller(protected_, level);

  // 3. Fragment multi-clause sentences
  const fragmented = fragmentSentences(stripped, level);

  // 4. Drop low-value sentences (ultra only — gets us from 25% to ~40%)
  const scored =
    level === "ultra" ? dropLowValueSentences(fragmented) : fragmented;

  // 5. Clean up whitespace
  const cleaned = cleanupWhitespace(scored);

  // 5. Restore protected content (multi-pass for nested patterns)
  const compressed = restoreSegments(cleaned, segments);

  // 6. Validate
  const segValidation = validateSegments(compressed, segments);
  const structValidation = validateStructure(content, compressed);
  const allErrors = [...segValidation.errors, ...structValidation.errors];
  const validationOk = allErrors.length === 0;

  const tokensAfter = approxTokens(compressed);
  const reductionPct =
    tokensBefore > 0
      ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)
      : 0;

  return {
    original: content,
    compressed,
    tokensBefore,
    tokensAfter,
    reductionPct,
    preservedSegments: segments.length,
    validationOk,
    validationErrors: allErrors,
  };
}

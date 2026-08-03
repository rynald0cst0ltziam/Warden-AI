/**
 * Heuristic task classifier — keyword + signal based, no LLM required.
 *
 * Good enough to be a directionally-useful filter for the pruning modules.
 * The blueprint calls for "a cheap, fast model call (or even a well-tuned
 * local classifier)" — this is the latter, with an LLM hook on top.
 */
import type {
  ClassifyInput,
  LLMClient,
  TaskContext,
  TaskType,
} from "./types.js";
import { NullLLMClient, TASK_TYPES } from "./types.js";

interface Rule {
  type: TaskType;
  keywords: RegExp[];
}

const RULES: Rule[] = [
  {
    type: "bug-fix",
    keywords: [
      /\bbug\b/i,
      /\bfix\b/i,
      /\berror\b/i,
      /\bcrash\b/i,
      /\bstack trace\b/i,
      /\bnull.?pointer\b/i,
      /\bregression\b/i,
      /\bnot working\b/i,
      /\bfailing\b/i,
      /\bexception\b/i,
      /\btraceback\b/i,
      /\bwrong\b/i,
      /\bbroken\b/i,
    ],
  },
  {
    type: "refactor",
    keywords: [
      /\brefactor\b/i,
      /\bclean up\b/i,
      /\bcleanup\b/i,
      /\brestructure\b/i,
      /\bextract\b/i,
      /\brename\b/i,
      /\bmove .*(into|to)\b/i,
      /\bsplit\b/i,
      /\bde.?duplicate\b/i,
      /\bconsolidate\b/i,
    ],
  },
  {
    type: "new-feature",
    keywords: [
      /\badd (a |an |the )?feature\b/i,
      /\bimplement\b/i,
      /\bcreate (a |an |the )?\b/i,
      /\bbuild (a |an |the )?\b/i,
      /\bsupport for\b/i,
      /\bnew endpoint\b/i,
      /\bnew command\b/i,
      /\bnew route\b/i,
    ],
  },
  {
    type: "test-writing",
    keywords: [
      /\btest\b/i,
      /\bunit test\b/i,
      /\bspec\b/i,
      /\bcoverage\b/i,
      /\bmock\b/i,
      /\bstub\b/i,
      /\bfixture\b/i,
    ],
  },
  {
    type: "docs",
    keywords: [
      /\bdocument(?:ation)?\b/i,
      /\breadme\b/i,
      /\bcomment\b/i,
      /\bjSDoc\b/i,
      /\bdocstring\b/i,
      /\bchangelog\b/i,
      /\bexplain\b/i,
    ],
  },
  {
    type: "config-infra",
    keywords: [
      /\bconfig\b/i,
      /\bci\b/i,
      /\bdocker\b/i,
      /\bkubernetes\b/i,
      /\bdeploy\b/i,
      /\binfrastructure\b/i,
      /\benv var\b/i,
      /\bpackage\.json\b/i,
      /\bcargo\.toml\b/i,
      /\bworkflow\b/i,
      /\bterraform\b/i,
      /\bmigration\b/i,
    ],
  },
  {
    type: "exploration",
    keywords: [
      /\bwhere (is|are)\b/i,
      /\bfind\b/i,
      /\bsearch\b/i,
      /\bshow me\b/i,
      /\blist (all )?\b/i,
      /\bwhat does\b/i,
      /\bhow does\b/i,
      /\bexplore\b/i,
      /\bunderstand\b/i,
      /\btrace\b/i,
    ],
  },
];

function scoreType(text: string, type: TaskType): number {
  const rule = RULES.find((r) => r.type === type);
  if (!rule) return 0;
  let score = 0;
  for (const kw of rule.keywords) if (kw.test(text)) score++;
  return score;
}

function pickType(text: string): TaskType {
  let best: TaskType = "unknown";
  let bestScore = 0;
  for (const r of RULES) {
    const s = scoreType(text, r.type);
    if (s > bestScore) {
      best = r.type;
      bestScore = s;
    }
  }
  return best;
}

function buildHint(userMessage: string, type: TaskType): string {
  const firstLine =
    userMessage.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim().slice(0, 160);
  if (type === "unknown") return trimmed;
  return `${type}: ${trimmed}`;
}

export class HeuristicClassifier {
  classify(input: ClassifyInput): TaskContext {
    const text = [input.userMessage, ...(input.recentTurns ?? [])].join("\n");
    const type = pickType(text);
    return {
      type,
      relevanceHint: buildHint(input.userMessage, type),
      userMessage: input.userMessage.slice(0, 500),
      toolName: input.toolName ?? null,
    };
  }
}

/**
 * Composite classifier: tries a cheap LLM first (if configured), falls back to
 * the heuristic. The LLM is asked to return a strict `TYPE|hint` line so we
 * can parse it defensively.
 */
export class TaskClassifier {
  private readonly llm: LLMClient;
  private readonly heuristic = new HeuristicClassifier();

  constructor(llm: LLMClient = new NullLLMClient()) {
    this.llm = llm;
  }

  async classify(input: ClassifyInput): Promise<TaskContext> {
    const heur = this.heuristic.classify(input);
    try {
      const prompt = `Classify the current coding task into exactly one of:
[bug-fix, refactor, new-feature, exploration, test-writing, docs, config-infra, unknown]
Then write a short relevance hint (<=20 words) about what the agent is doing.

User message: ${input.userMessage.slice(0, 800)}
Tool about to be called: ${input.toolName ?? "unknown"}

Reply in the exact form: TYPE|hint`;
      const raw = await this.llm.complete(prompt);
      if (raw) {
        const m = /^([a-z-]+)\|(.+)$/i.exec(raw.trim());
        if (m) {
          const type = (m[1] ?? "").toLowerCase() as TaskType;
          const hint = (m[2] ?? "").trim();
          if (TASK_TYPES.includes(type)) {
            return {
              type,
              relevanceHint: hint || heur.relevanceHint,
              userMessage: heur.userMessage,
              toolName: input.toolName ?? null,
            };
          }
        }
      }
    } catch {
      // fall through to heuristic
    }
    return heur;
  }
}

export { NullLLMClient } from "./types.js";
export type {
  ClassifyInput,
  LLMClient,
  TaskContext,
  TaskType,
} from "./types.js";
export { TASK_TYPES } from "./types.js";

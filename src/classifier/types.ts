/**
 * Task type taxonomy. Fixed set — the classifier picks one of these plus a
 * free-text "relevance hint" describing what the agent is actually trying to
 * do right now. This is a directionally-useful filter, not a perfect label;
 * the eval gate's feedback loop refines it over time.
 */
export type TaskType =
  | "bug-fix"
  | "refactor"
  | "new-feature"
  | "exploration"
  | "test-writing"
  | "docs"
  | "config-infra"
  | "unknown";

export const TASK_TYPES: TaskType[] = [
  "bug-fix",
  "refactor",
  "new-feature",
  "exploration",
  "test-writing",
  "docs",
  "config-infra",
  "unknown",
];

export interface TaskContext {
  type: TaskType;
  /** Free-text, e.g. "user is debugging a null-pointer in auth.py". */
  relevanceHint: string;
  /** The user message that triggered the current turn (truncated). */
  userMessage: string;
  /** Which tool is about to be called, if known. */
  toolName: string | null;
}

export interface ClassifyInput {
  userMessage: string;
  /** Recent conversation turns, most-recent last. */
  recentTurns?: string[];
  toolName?: string | null;
}

/** A pluggable LLM client. The classifier uses a cheap/fast model behind this
 *  abstraction so the model can be swapped without touching the pipeline. */
export interface LLMClient {
  /** Returns a short completion, or null if unavailable (falls back to heuristic). */
  complete(prompt: string): Promise<string | null>;
}

export class NullLLMClient implements LLMClient {
  async complete(_prompt: string): Promise<string | null> {
    return null;
  }
}

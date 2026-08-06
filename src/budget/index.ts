/**
 * Budget caps — enforce per-seat and per-project token spend limits.
 *
 * Tracks token spend per scope (seat/project) and logs alerts when caps
 * are exceeded. Pruning continues (safety first), but the log gives
 * teams visibility into runaway spend.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { logger } from "../logging/index.js";

export interface BudgetCap {
  /** Scope name: "seat:alice@example.com" or "project:my-app". */
  scope: string;
  /** Maximum tokens per billing period. */
  capTokens: number;
  /** Billing period in days (default 30). */
  periodDays: number;
}

export interface BudgetUsage {
  scope: string;
  spent: number;
  cap: number;
  periodStart: string;
  /** Whether the cap has been exceeded this period. */
  exceeded: boolean;
}

interface BudgetState {
  caps: BudgetCap[];
  usage: Record<
    string,
    { spent: number; periodStart: string; alerted: boolean }
  >;
}

function budgetPath(): string {
  return join(homedir(), ".warden", "budgets.json");
}

function loadState(): BudgetState {
  const p = budgetPath();
  if (!existsSync(p)) return { caps: [], usage: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BudgetState;
  } catch {
    return { caps: [], usage: {} };
  }
}

async function loadStateAsync(): Promise<BudgetState> {
  const p = budgetPath();
  try {
    const data = await readFile(p, "utf8");
    return JSON.parse(data) as BudgetState;
  } catch {
    return { caps: [], usage: {} };
  }
}

function saveState(state: BudgetState): void {
  const dir = join(homedir(), ".warden");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(budgetPath(), JSON.stringify(state, null, 2), "utf8");
}

async function saveStateAsync(state: BudgetState): Promise<void> {
  const dir = join(homedir(), ".warden");
  await mkdir(dir, { recursive: true });
  await writeFile(budgetPath(), JSON.stringify(state, null, 2), "utf8");
}

/** Set or update a budget cap for a scope. */
export function setBudgetCap(
  scope: string,
  capTokens: number,
  periodDays = 30,
): void {
  const state = loadState();
  const existing = state.caps.findIndex((c) => c.scope === scope);
  const cap: BudgetCap = { scope, capTokens, periodDays };
  if (existing >= 0) {
    state.caps[existing] = cap;
  } else {
    state.caps.push(cap);
  }
  saveState(state);
  logger.info("budget cap set", { scope, capTokens, periodDays });
}

/** Remove a budget cap. */
export function removeBudgetCap(scope: string): void {
  const state = loadState();
  state.caps = state.caps.filter((c) => c.scope !== scope);
  delete state.usage[scope];
  saveState(state);
}

/** List all configured budget caps. */
export function listBudgetCaps(): BudgetCap[] {
  return loadState().caps;
}

/** Check if a period has rolled over and reset usage if so. */
function maybeResetPeriod(
  state: BudgetState,
  scope: string,
  cap: BudgetCap,
): void {
  const usage = state.usage[scope];
  if (!usage) return;
  const periodMs = cap.periodDays * 86_400_000;
  const elapsed = Date.now() - new Date(usage.periodStart).getTime();
  if (elapsed > periodMs) {
    state.usage[scope] = {
      spent: 0,
      periodStart: new Date().toISOString(),
      alerted: false,
    };
  }
}

/**
 * Record token spend for a scope and check against caps.
 * Returns the updated usage, or null if no cap is configured for this scope.
 */
export async function recordSpend(
  scope: string,
  tokens: number,
): Promise<BudgetUsage | null> {
  const state = await loadStateAsync();
  const cap = state.caps.find((c) => c.scope === scope);
  if (!cap) return null;

  maybeResetPeriod(state, scope, cap);

  if (!state.usage[scope]) {
    state.usage[scope] = {
      spent: 0,
      periodStart: new Date().toISOString(),
      alerted: false,
    };
  }

  state.usage[scope]!.spent += tokens;
  const usage = state.usage[scope]!;
  const exceeded = usage.spent > cap.capTokens;

  // Log alert on first crossing of the cap.
  if (exceeded && !usage.alerted) {
    usage.alerted = true;
    logger.warn("budget cap exceeded", {
      scope,
      spent: usage.spent,
      cap: cap.capTokens,
    });
  }

  await saveStateAsync(state);

  return {
    scope,
    spent: usage.spent,
    cap: cap.capTokens,
    periodStart: usage.periodStart,
    exceeded,
  };
}

/** Get current usage for all scopes with caps. */
export function budgetReport(): BudgetUsage[] {
  const state = loadState();
  return state.caps.map((cap) => {
    maybeResetPeriod(state, cap.scope, cap);
    const usage = state.usage[cap.scope];
    return {
      scope: cap.scope,
      spent: usage?.spent ?? 0,
      cap: cap.capTokens,
      periodStart: usage?.periodStart ?? new Date().toISOString(),
      exceeded: (usage?.spent ?? 0) > cap.capTokens,
    };
  });
}

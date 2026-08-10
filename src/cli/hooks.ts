/**
 * Agent hooks — installs PreToolUse hooks that intercept built-in tool calls
 * and redirect them to Warden wrapper tools.
 *
 * This is the enforcement layer. Rules files are advisory (agents can ignore
 * them), but hooks are deterministic: they run before every tool call and
 * can block it with a message telling the agent to use the Warden wrapper
 * instead.
 *
 * Supported agents:
 *   - Claude Code: .claude/settings.json (PreToolUse with matchers)
 *   - Devin CLI:   .devin/hooks.v1.json  (PreToolUse with matchers)
 *
 * Both use the same protocol:
 *   - Hook receives JSON on stdin: { tool_name, tool_input }
 *   - Exit 0 = allow, exit 2 = block (stderr fed back to agent)
 *   - The command is `warden hook redirect` (added to CLI)
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "../logging/index.js";

export interface HookTarget {
  agent: string;
  path: string;
  written: boolean;
  note?: string;
}

/**
 * Build the Claude Code settings.json with PreToolUse hooks.
 * Merges with existing settings — never overwrites user's other hooks.
 */
function buildClaudeSettings(existing: string, wardenCommand: string): string {
  const settings = existing.trim() ? JSON.parse(existing) : {};

  // Ensure hooks.PreToolUse exists
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  const preToolUse = settings.hooks.PreToolUse as Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
  }>;

  // Remove any existing Warden-managed entries (idempotent re-install)
  const filtered = preToolUse.filter(
    (entry) => !entry.hooks?.some((h) => h.command?.includes("warden hook redirect")),
  );

  // Add Warden interceptors for Read and Grep/Search tools
  filtered.push({
    matcher: "Read|read|read_file|file_read",
    hooks: [
      {
        type: "command",
        command: `${wardenCommand} hook redirect`,
      },
    ],
  });
  filtered.push({
    matcher: "Grep|grep|Search|search|code_search",
    hooks: [
      {
        type: "command",
        command: `${wardenCommand} hook redirect`,
      },
    ],
  });

  settings.hooks.PreToolUse = filtered;
  return JSON.stringify(settings, null, 2) + "\n";
}

/**
 * Build the Devin hooks.v1.json with PreToolUse hooks.
 * Merges with existing settings — never overwrites user's other hooks.
 */
function buildDevinHooks(existing: string, wardenCommand: string): string {
  const hooks = existing.trim() ? JSON.parse(existing) : {};

  if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];

  const preToolUse = hooks.PreToolUse as Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string; timeout?: number }>;
  }>;

  // Remove any existing Warden-managed entries (idempotent re-install)
  const filtered = preToolUse.filter(
    (entry) => !entry.hooks?.some((h) => h.command?.includes("warden hook redirect")),
  );

  // Add Warden interceptors for Read and Grep/Search tools
  filtered.push({
    matcher: "read|read_file|file_read",
    hooks: [
      {
        type: "command",
        command: `${wardenCommand} hook redirect`,
        timeout: 5,
      },
    ],
  });
  filtered.push({
    matcher: "grep|search|code_search",
    hooks: [
      {
        type: "command",
        command: `${wardenCommand} hook redirect`,
        timeout: 5,
      },
    ],
  });

  hooks.PreToolUse = filtered;
  return JSON.stringify(hooks, null, 2) + "\n";
}

/**
 * Install PreToolUse hooks for supported agents.
 * Called by `warden init` as a new step.
 */
export function installHooks(repoRoot: string, wardenCommand = "warden"): HookTarget[] {
  const targets: HookTarget[] = [
    {
      agent: "Claude Code",
      path: join(repoRoot, ".claude", "settings.json"),
      written: false,
    },
    {
      agent: "Devin CLI",
      path: join(repoRoot, ".devin", "hooks.v1.json"),
      written: false,
    },
  ];

  for (const target of targets) {
    try {
      const dir = dirname(target.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const existing = existsSync(target.path)
        ? readFileSync(target.path, "utf8")
        : "";

      const isClaude = target.agent === "Claude Code";
      const builder = isClaude ? buildClaudeSettings : buildDevinHooks;
      const updated = builder(existing, wardenCommand);

      if (updated === existing) {
        target.written = false; // already up to date
      } else {
        writeFileSync(target.path, updated, "utf8");
        target.written = true;
        logger.info("installed warden hooks", {
          agent: target.agent,
          path: target.path,
        });
      }
    } catch (err) {
      target.written = false;
      target.note = `failed: ${String(err)}`;
      logger.warn("failed to install hooks", {
        agent: target.agent,
        path: target.path,
        err: String(err),
      });
    }
  }

  return targets;
}

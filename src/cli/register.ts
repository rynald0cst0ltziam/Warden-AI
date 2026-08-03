/**
 * Auto-register Warden as an MCP server in every MCP-compatible agent config
 * Warden can find.
 *
 * `warden init` detects the agent(s) in use and registers itself, so the user
 * doesn't have to hand-edit JSON. Idempotent — safe to re-run.
 *
 * Supported targets (30+ MCP-compatible agents):
 *   - Claude Code:    ~/.claude.json (mcpServers key) + .mcp.json in repo
 *   - Claude Desktop: ~/.config/claude-desktop/mcp.json
 *   - Cursor:         ~/.cursor/mcp.json + .cursor/mcp.json in repo
 *   - Windsurf/Devin: ~/.codeium/windsurf/mcp_config.json
 *   - Codex:          ~/.codex/config.toml (TOML format)
 *   - Cline:          ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 *   - Roo Code:       Same as Cline (shared architecture)
 *   - Continue:       ~/.continue/config.json (YAML/JSON)
 *   - VS Code Copilot:.vscode/mcp.json in repo + user settings
 *   - Zed:            ~/.config/zed/settings.json
 *   - JetBrains:      ~/.config/JetBrains/mcp.json
 *   - Amazon Q:       ~/.aws/amazonq/mcp.json
 *   - Gemini CLI:     ~/.gemini/settings.json (experimental MCP)
 *   - Antigravity:    ~/.gemini/antigravity/mcp_config.json (v1) + ~/.gemini/config/mcp_config.json (v2 shared)
 *   - Aider:          ~/.aider/mcp.json
 *   - Goose:          ~/.config/goose/mcp.json
 *   - OpenHands:      ~/.config/openhands/mcp.json
 *   - opencode:       ~/.config/opencode/mcp.json
 *   - Augment Code:   ~/.config/augment/mcp.json
 *   - Cohere Catalyst:~/.config/catalyst/mcp.json
 *   - Warp:           ~/.config/warp/mcp.json
 *   - Crush:          ~/.config/crush/mcp.json
 *   - Smithery:       ~/.config/smithery/mcp.json
 *   - AgentQL:        ~/.config/agentql/mcp.json
 *   - Cody:           ~/.config/cody/mcp.json
 *   - Tabnine:        ~/.config/tabnine/mcp.json
 *   - Replit AI:      ~/.config/replit/mcp.json
 *   - Zentrik:        ~/.config/zentrik/mcp.json
 *   - Generic MCP:    ~/.config/mcp/servers.json (fallback for any MCP client)
 *
 * We never overwrite existing entries — we merge Warden in. If Warden is
 * already registered, we leave it alone.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logging/index.js";

export interface RegisterTarget {
  agent: string;
  path: string;
  registered: boolean;
  note?: string;
}

interface McpServersJson {
  mcpServers?: Record<string, unknown>;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * True if the path exists but its contents are NOT valid JSON. We use this to
 * avoid clobbering a config file we can't safely merge into — better to skip
 * and warn than to overwrite a user's (possibly recoverable) config.
 */
function existsButUnparseable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return false;
  } catch {
    return true;
  }
}

/**
 * Write JSON atomically: write to a temp file, then rename over the target.
 * A rename is atomic on the same filesystem, so a crash mid-write can never
 * leave a half-written (corrupt) config behind.
 */
function writeJson(path: string, data: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.warden-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function wardenServerEntry(command: string): Record<string, unknown> {
  // Split command into command + args. Handle quoted paths (e.g. node "C:\path with spaces\cli.js")
  // by stripping surrounding quotes from each part after splitting on whitespace.
  // JSON config files don't need shell quoting — each arg is a separate array element.
  const parts = command.split(/\s+/).map((p) => p.replace(/^"(.*)"$/, "$1"));
  return {
    command: parts[0] ?? command,
    args: [...parts.slice(1), "serve"],
    env: {},
  };
}

export function registerInMcpJson(
  path: string,
  command: string,
  agentLabel: string,
): RegisterTarget {
  if (!existsSync(path)) {
    writeJson(path, { mcpServers: { Warden: wardenServerEntry(command) } });
    return { agent: agentLabel, path, registered: true };
  }
  // File exists but isn't valid JSON — don't clobber it. Warn and skip.
  if (existsButUnparseable(path)) {
    logger.warn("skipping malformed config (not overwriting)", {
      agent: agentLabel,
      path,
    });
    return {
      agent: agentLabel,
      path,
      registered: false,
      note: "existing file is not valid JSON — skipped to avoid clobbering",
    };
  }
  const data = readJson<McpServersJson>(path) ?? {};
  const servers = data.mcpServers ?? {};
  // Migrate old lowercase "warden" key to "Warden" if present
  if (servers["warden"] && !servers["Warden"]) {
    servers["Warden"] = servers["warden"];
    delete servers["warden"];
    data.mcpServers = servers;
    writeJson(path, data);
    return { agent: agentLabel, path, registered: true, note: "migrated from 'warden' to 'Warden'" };
  }
  if (servers["warden"] && servers["Warden"]) {
    // Both exist — remove old lowercase, keep Warden
    delete servers["warden"];
    data.mcpServers = servers;
    writeJson(path, data);
    return { agent: agentLabel, path, registered: false, note: "already registered (removed duplicate lowercase entry)" };
  }
  if (servers["Warden"]) {
    return {
      agent: agentLabel,
      path,
      registered: false,
      note: "already registered",
    };
  }
  servers["Warden"] = wardenServerEntry(command);
  data.mcpServers = servers;
  writeJson(path, data);
  return { agent: agentLabel, path, registered: true };
}

/** Best-effort TOML append for Codex config. */
function registerInCodexToml(path: string, command: string): RegisterTarget {
  const header = "\n# Added by `warden init`\n";
  // Escape backslashes for TOML string values (Windows paths)
  const tomlCommand = command.replace(/\\/g, "\\\\");
  const block = `[mcp_servers.Warden]\ncommand = "${tomlCommand}"\nargs = ["serve"]\n`;
  if (!existsSync(path)) {
    if (!existsSync(dirname(path)))
      mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, header + block, "utf8");
    return { agent: "codex", path, registered: true };
  }
  const existing = readFileSync(path, "utf8");
  // Migrate old lowercase key
  if (existing.includes("[mcp_servers.warden]") && !existing.includes("[mcp_servers.Warden]")) {
    const migrated = existing.replace("[mcp_servers.warden]", "[mcp_servers.Warden]");
    writeFileSync(path, migrated, "utf8");
    return { agent: "codex", path, registered: true, note: "migrated from 'warden' to 'Warden'" };
  }
  if (existing.includes("[mcp_servers.warden]") || existing.includes("[mcp_servers.Warden]")) {
    return {
      agent: "codex",
      path,
      registered: false,
      note: "already registered",
    };
  }
  writeFileSync(path, existing + header + block, "utf8");
  return { agent: "codex", path, registered: true };
}

/**
 * Resolve the best command to invoke Warden.
 * On Windows, GUI apps (like Antigravity, Cursor) may not inherit the npm
 * global bin directory on PATH. If `warden` isn't resolvable, fall back to
 * `node <dist/cli.js>` using the current module's location.
 */
function resolveWardenCommand(preferred: string): string {
  // If the caller specified something other than plain "warden", trust them.
  if (preferred !== "warden") return preferred;

  try {
    // Check if `warden` is resolvable via PATH
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const check = process.platform === "win32" ? "where warden" : "which warden";
    execSync(check, { stdio: "ignore", timeout: 3000 });
    // Found on PATH — use it
    return "warden";
  } catch {
    // Not on PATH — resolve to node + dist/cli.js
    const cliPath = fileURLToPath(import.meta.url);
    const distDir = dirname(cliPath);
    const cliJs = join(distDir, "cli.js");
    if (existsSync(cliJs)) {
      return `node "${cliJs}"`;
    }
    // Last resort: try the package root
    const pkgRoot = join(distDir, "..");
    const fallback = join(pkgRoot, "dist", "cli.js");
    if (existsSync(fallback)) {
      return `node "${fallback}"`;
    }
    return "warden"; // give up, let the user figure it out
  }
}

/**
 * Register Warden as an MCP server everywhere we can find.
 * @param command The command to invoke Warden with (e.g. "warden" or "npx warden").
 */
export function registerEverywhere(command = "warden"): RegisterTarget[] {
  const home = homedir();
  const cwd = process.cwd();
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const targets: RegisterTarget[] = [];

  // Resolve the actual command to use (may differ from "warden" if not on PATH)
  const resolvedCommand = resolveWardenCommand(command);

  // ---- Claude Code (global ~/.claude.json + repo-local .mcp.json) ----
  // Always create ~/.claude.json if it doesn't exist — Claude Code reads this
  // on startup, so we register Warden here even if the user just installed it.
  const claudeHome = join(home, ".claude.json");
  if (existsButUnparseable(claudeHome)) {
    logger.warn("skipping malformed config (not overwriting)", {
      agent: "Claude Code",
      path: claudeHome,
    });
    targets.push({
      agent: "Claude Code",
      path: claudeHome,
      registered: false,
      note: "existing file is not valid JSON — skipped to avoid clobbering",
    });
  } else {
    const data = readJson<McpServersJson>(claudeHome) ?? {};
    const servers = data.mcpServers ?? {};
    // Migrate old lowercase "warden" key to "Warden"
    if (servers["warden"] && !servers["Warden"]) {
      servers["Warden"] = servers["warden"];
      delete servers["warden"];
      data.mcpServers = servers;
      writeJson(claudeHome, data);
      targets.push({
        agent: "Claude Code",
        path: claudeHome,
        registered: true,
        note: "migrated from 'warden' to 'Warden'",
      });
    } else if (servers["Warden"]) {
      // Clean up old lowercase if both exist
      if (servers["warden"]) {
        delete servers["warden"];
        data.mcpServers = servers;
        writeJson(claudeHome, data);
      }
      targets.push({
        agent: "Claude Code",
        path: claudeHome,
        registered: false,
        note: "already registered",
      });
    } else {
      servers["Warden"] = wardenServerEntry(resolvedCommand);
      data.mcpServers = servers;
      writeJson(claudeHome, data);
      targets.push({
        agent: "Claude Code",
        path: claudeHome,
        registered: true,
      });
    }
  }
  targets.push(
    registerInMcpJson(join(cwd, ".mcp.json"), resolvedCommand, "Claude Code (project)"),
  );

  // ---- Cursor (global + repo-local) ----
  targets.push(
    registerInMcpJson(join(home, ".cursor", "mcp.json"), resolvedCommand, "Cursor"),
  );
  targets.push(
    registerInMcpJson(
      join(cwd, ".cursor", "mcp.json"),
      resolvedCommand,
      "Cursor (project)",
    ),
  );

  // ---- Windsurf / Devin ----
  targets.push(
    registerInMcpJson(
      join(home, ".codeium", "windsurf", "mcp_config.json"),
      resolvedCommand,
      "Windsurf/Devin",
    ),
  );
  // Devin CLI (project-level + user-level)
  targets.push(
    registerInMcpJson(
      join(cwd, ".devin", "config.json"),
      resolvedCommand,
      "Devin (project)",
    ),
  );
  const devinUserDir = isWin
    ? join(home, "AppData", "Roaming", "devin")
    : join(home, ".config", "devin");
  targets.push(
    registerInMcpJson(join(devinUserDir, "config.json"), resolvedCommand, "Devin CLI"),
  );
  // Devin CLI also reads mcp_config.json (legacy/alternative path)
  targets.push(
    registerInMcpJson(join(devinUserDir, "mcp_config.json"), resolvedCommand, "Devin CLI (mcp_config)"),
  );

  // ---- Codex (TOML format) ----
  targets.push(
    registerInCodexToml(join(home, ".codex", "config.toml"), resolvedCommand),
  );

  // ---- Cline (VS Code extension, shared with Roo Code) ----
  const clineBase = isWin
    ? join(
        home,
        "AppData",
        "Roaming",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
      )
    : isMac
      ? join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
        )
      : join(
          home,
          ".config",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
        );
  targets.push(
    registerInMcpJson(
      join(clineBase, "cline_mcp_settings.json"),
      resolvedCommand,
      "Cline",
    ),
  );

  // ---- Roo Code (same architecture as Cline, different extension ID) ----
  const rooBase = isWin
    ? join(
        home,
        "AppData",
        "Roaming",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
      )
    : isMac
      ? join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "globalStorage",
          "rooveterinaryinc.roo-cline",
          "settings",
        )
      : join(
          home,
          ".config",
          "Code",
          "User",
          "globalStorage",
          "rooveterinaryinc.roo-cline",
          "settings",
        );
  targets.push(
    registerInMcpJson(
      join(rooBase, "cline_mcp_settings.json"),
      resolvedCommand,
      "Roo Code",
    ),
  );

  // ---- Continue (open-source AI code assistant) ----
  const continueDir = join(home, ".continue");
  targets.push(
    registerInMcpJson(join(continueDir, "config.json"), resolvedCommand, "Continue"),
  );

  // ---- VS Code (GitHub Copilot MCP support) ----
  targets.push(
    registerInMcpJson(
      join(cwd, ".vscode", "mcp.json"),
      resolvedCommand,
      "VS Code Copilot (project)",
    ),
  );

  // ---- Zed editor ----
  const zedDir = isWin
    ? join(home, "AppData", "Roaming", "zed")
    : isMac
      ? join(home, "Library", "Application Support", "zed")
      : join(home, ".config", "zed");
  // Zed uses a settings.json with an mcp_servers key (not mcpServers)
  const zedSettings = join(zedDir, "settings.json");
  if (existsButUnparseable(zedSettings)) {
    logger.warn("skipping malformed config (not overwriting)", {
      agent: "Zed",
      path: zedSettings,
    });
    targets.push({
      agent: "Zed",
      path: zedSettings,
      registered: false,
      note: "existing file is not valid JSON — skipped to avoid clobbering",
    });
  } else {
    const data = readJson<Record<string, unknown>>(zedSettings) ?? {};
    const servers =
      (data["mcp_servers"] as Record<string, unknown> | undefined) ?? {};
    // Migrate old lowercase "warden" key to "Warden"
    if (servers["warden"] && !servers["Warden"]) {
      servers["Warden"] = servers["warden"];
      delete servers["warden"];
      data["mcp_servers"] = servers;
      writeJson(zedSettings, data);
      targets.push({ agent: "Zed", path: zedSettings, registered: true, note: "migrated from 'warden' to 'Warden'" });
    } else if (servers["Warden"]) {
      if (servers["warden"]) {
        delete servers["warden"];
        data["mcp_servers"] = servers;
        writeJson(zedSettings, data);
      }
      targets.push({ agent: "Zed", path: zedSettings, registered: false, note: "already registered" });
    } else {
      servers["Warden"] = wardenServerEntry(resolvedCommand);
      data["mcp_servers"] = servers;
      writeJson(zedSettings, data);
      targets.push({ agent: "Zed", path: zedSettings, registered: true });
    }
  }

  // ---- JetBrains (IntelliJ, WebStorm, etc.) ----
  const jetbrainsDir = isWin
    ? join(home, "AppData", "Roaming", "JetBrains")
    : isMac
      ? join(home, "Library", "Application Support", "JetBrains")
      : join(home, ".config", "JetBrains");
  targets.push(
    registerInMcpJson(join(jetbrainsDir, "mcp.json"), resolvedCommand, "JetBrains"),
  );

  // ---- Amazon Q Developer ----
  const amazonQDir = join(home, ".aws", "amazonq");
  targets.push(
    registerInMcpJson(join(amazonQDir, "mcp.json"), resolvedCommand, "Amazon Q"),
  );

  // ---- Gemini CLI (experimental MCP support) ----
  const geminiDir = join(home, ".gemini");
  targets.push(
    registerInMcpJson(join(geminiDir, "settings.json"), resolvedCommand, "Gemini CLI"),
  );

  // ---- Google Antigravity (AI-first IDE, shares ~/.gemini with Gemini CLI) ----
  // v1: ~/.gemini/antigravity/mcp_config.json
  // v2.0+: ~/.gemini/config/mcp_config.json (shared across Antigravity IDE, agy CLI, SDK)
  targets.push(
    registerInMcpJson(
      join(geminiDir, "antigravity", "mcp_config.json"),
      resolvedCommand,
      "Antigravity",
    ),
  );
  targets.push(
    registerInMcpJson(
      join(geminiDir, "config", "mcp_config.json"),
      resolvedCommand,
      "Antigravity (shared)",
    ),
  );

  // ---- Aider (AI coding assistant, MCP support via config) ----
  targets.push(
    registerInMcpJson(
      join(home, ".aider", "mcp.json"),
      resolvedCommand,
      "Aider",
    ),
  );

  // ---- Goose (Block's AI agent, MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "goose", "mcp.json"),
      resolvedCommand,
      "Goose",
    ),
  );

  // ---- OpenHands (open-source AI agent, MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "openhands", "mcp.json"),
      resolvedCommand,
      "OpenHands",
    ),
  );

  // ---- opencode (open-source coding agent) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "opencode", "mcp.json"),
      resolvedCommand,
      "opencode",
    ),
  );

  // ---- Augment Code (AI code assistant) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "augment", "mcp.json"),
      resolvedCommand,
      "Augment Code",
    ),
  );

  // ---- Cohere Catalyst (AI agent) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "catalyst", "mcp.json"),
      resolvedCommand,
      "Cohere Catalyst",
    ),
  );

  // ---- Warp (terminal with AI, MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "warp", "mcp.json"),
      resolvedCommand,
      "Warp",
    ),
  );

  // ---- Crush (AI coding agent) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "crush", "mcp.json"),
      resolvedCommand,
      "Crush",
    ),
  );

  // ---- Claude Desktop (Anthropic's desktop app, MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "claude-desktop", "mcp.json"),
      resolvedCommand,
      "Claude Desktop",
    ),
  );

  // ---- Smithery (MCP tool registry) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "smithery", "mcp.json"),
      resolvedCommand,
      "Smithery",
    ),
  );

  // ---- AgentQL (AI testing agent) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "agentql", "mcp.json"),
      resolvedCommand,
      "AgentQL",
    ),
  );

  // ---- Cody (Sourcegraph's AI code assistant) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "cody", "mcp.json"),
      resolvedCommand,
      "Cody",
    ),
  );

  // ---- Tabnine (AI code assistant, MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "tabnine", "mcp.json"),
      resolvedCommand,
      "Tabnine",
    ),
  );

  // ---- Replit AI (cloud IDE with MCP support) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "replit", "mcp.json"),
      resolvedCommand,
      "Replit AI",
    ),
  );

  // ---- Zentrik / Zed-like agents that use standard MCP config ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "zentrik", "mcp.json"),
      resolvedCommand,
      "Zentrik",
    ),
  );

  // ---- Generic MCP config fallback (any tool using ~/.config/mcp/servers.json) ----
  targets.push(
    registerInMcpJson(
      join(home, ".config", "mcp", "servers.json"),
      resolvedCommand,
      "Generic MCP",
    ),
  );

  logger.info("registration complete", {
    registered: targets.filter((t) => t.registered).length,
    total: targets.length,
  });
  return targets;
}

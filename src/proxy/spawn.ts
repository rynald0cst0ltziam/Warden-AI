/**
 * Windows-safe spawn resolution for upstream MCP servers.
 *
 * On Windows, npm tools arrive as .cmd shims. We need to resolve through
 * PATH/PATHEXT and launch their Node target directly — never join upstream
 * arguments into a cmd.exe string (injection risk).
 *
 * On POSIX, we pass the command through unchanged.
 *
 * Adapted from caveman-shrink's spawn-options.js (MIT licensed, by Julius Brussee).
 * https://github.com/JuliusBrussee/caveman
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, dirname, extname } from "node:path";

export interface SpawnInvocation {
  command: string;
  args: string[];
}

/** Find an executable in PATH using PATHEXT semantics (Windows only). */
function resolveWindowsCommand(command: string, env: Record<string, string>): string | null {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    return existsSync(command) ? command : null;
  }

  const pathExt = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const names = extname(command)
    ? [command]
    : pathExt
        .split(";")
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
        .map((ext) => `${command}${ext}`);

  const pathDirs = (env.PATH || "").split(";");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a command + args into a safe spawn invocation.
 * On Windows, resolves .cmd/.bat shims to their Node target.
 * Throws if a Windows shim can't be safely resolved.
 */
export function getSpawnInvocation(
  command: string,
  args: string[],
  platform: string = process.platform,
  env: Record<string, string> = process.env as Record<string, string>,
): SpawnInvocation {
  if (platform !== "win32") {
    return { command, args: [...args] };
  }

  const executable = resolveWindowsCommand(command, env) || command;
  if (!/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }

  // Read the .cmd shim to find the Node script it launches
  const source = readFileSync(executable, "utf8");
  let relativeScript: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (!/\b(?:node(?:\.exe)?\b|_prog)/i.test(line) || !/%\*/.test(line)) continue;
    const match = line.match(/"%(?:dp0%|~dp0)\\([^"\r\n]+\.(?:cjs|mjs|js))"\s+%\*/i);
    if (match) {
      relativeScript = match[1]!;
      break;
    }
  }

  if (!relativeScript) {
    throw new Error(
      `cannot safely launch non-Node Windows command shim: ${executable}`,
    );
  }

  const script = join(dirname(executable), ...relativeScript.split(/[\\/]+/));
  if (!statSync(script).isFile()) {
    throw new Error(`Windows command shim target is missing: ${script}`);
  }

  return { command: process.execPath, args: [script, ...args] };
}

/** Get spawn options for the upstream MCP child process. */
export function getSpawnOptions(): {
  stdio: ["pipe", "pipe", "inherit"];
  windowsHide: true;
} {
  return {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  };
}

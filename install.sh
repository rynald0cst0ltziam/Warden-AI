#!/bin/sh
# Warden install script — curl-pipeable
# Usage: curl -fsSL https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/install.sh | bash
#
# Installs Warden globally via npm, then runs `warden init` which:
#   - Registers Warden as MCP server in all detected agents (30+)
#   - Writes agent rules files (CLAUDE.md, AGENTS.md, .cursorrules, etc.)
#   - Builds code index (call graph, impact analysis, architecture)
#   - Compresses memory files (saves tokens every future session)
#
# Everything is active after this one command. No proxy, no cloud, no config.

set -e

echo ""
echo "  Warden — structurally-verified context layer for AI coding agents"
echo "  ────────────────────────────────────────────────────────────────────"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js not found. Install Node 22.5+ from https://nodejs.org first."
  exit 1
fi

NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ] 2>/dev/null; then
  echo "  ✗ Node.js version too old. Warden requires Node 22.5+. Current: $(node -v)"
  exit 1
fi

echo "  ✓ Node.js $(node -v)"

# Check for npm
if ! command -v npm >/dev/null 2>&1; then
  echo "  ✗ npm not found. Install npm first."
  exit 1
fi

echo "  ✓ npm $(npm -v)"
echo ""

# Install Warden globally
echo "  Installing warden globally..."
npm install -g warden-ai 2>&1 | tail -1
echo ""

# Run init — use node directly to avoid PATH issues (Windows Git Bash, etc.)
echo "  Running warden init..."
WARDEN_CLI="$(npm root -g 2>/dev/null)/warden-ai/dist/cli.js"
if [ -f "$WARDEN_CLI" ]; then
  node "$WARDEN_CLI" init
else
  # Fallback: try warden from PATH
  warden init
fi
echo ""

echo "  Done. Restart your IDE and start working normally."
echo "  Warden runs automatically — no commands to remember."
echo ""

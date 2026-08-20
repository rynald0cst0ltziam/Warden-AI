# Warden install script for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/rynald0cst0ltziam/Warden-AI/main/install.ps1 | iex
#
# Installs Warden globally via npm, then runs warden init which:
#   - Registers Warden as MCP server in all detected agents (30+)
#   - Writes agent rules files (CLAUDE.md, AGENTS.md, .cursorrules, etc.)
#   - Builds code index (call graph, impact analysis, architecture)
#   - Compresses memory files (saves tokens every future session)

Write-Host ""
Write-Host "  Warden — verified context for AI coding agents" -ForegroundColor Cyan
Write-Host "  --------------------------------------------------------------------"
Write-Host ""

# Check for Node.js
$nodeVersion = $null
try { $nodeVersion = (& node -v 2>$null) } catch {}
if (-not $nodeVersion) {
    Write-Host "  Node.js not found. Install Node 22.5+ from https://nodejs.org first." -ForegroundColor Red
    exit 1
}

$major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($major -lt 22) {
    Write-Host "  Node.js version too old. Warden requires Node 22.5+. Current: $nodeVersion" -ForegroundColor Red
    exit 1
}

Write-Host "  Node.js $nodeVersion" -ForegroundColor Green

# Check for npm
$npmVersion = $null
try { $npmVersion = (& npm -v 2>$null) } catch {}
if (-not $npmVersion) {
    Write-Host "  npm not found. Install npm first." -ForegroundColor Red
    exit 1
}

Write-Host "  npm $npmVersion" -ForegroundColor Green
Write-Host ""

# Install Warden globally
Write-Host "  Installing warden globally..."
npm install -g warden-ai 2>&1 | Select-Object -Last 1
Write-Host ""

# Run init — use node directly to avoid PATH issues
Write-Host "  Running warden init..."
$wardenCli = Join-Path (npm root -g 2>$null) "warden-ai\dist\cli.js"
if (Test-Path $wardenCli) {
    node $wardenCli init
} else {
    # Fallback: try warden from PATH
    try { warden init } catch {
        Write-Host "  Could not run warden init. Run 'warden init' manually after restarting your terminal." -ForegroundColor Yellow
    }
}
Write-Host ""

Write-Host "  Done. Restart your IDE and start working normally." -ForegroundColor Green
Write-Host "  Warden runs automatically — no commands to remember."
Write-Host ""

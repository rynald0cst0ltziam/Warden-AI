/**
 * Local dashboard — a web UI served from the Warden CLI.
 *
 * Licensed feature. Runs a lightweight HTTP server on localhost
 * that shows:
 *   - Real-time rule status (stage, confidence, samples)
 *   - Token savings (session + all-time)
 *   - Recent decisions / audit trail
 *   - Budget caps and usage
 *   - Regression watchdog status
 *
 * No external dependencies — uses Node's built-in http module. The UI is a
 * single HTML page that polls a JSON API endpoint for live updates.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Warden } from "../warden.js";
import { budgetReport } from "../budget/index.js";
import { runWatchdogTiered } from "../watchdog/index.js";
import { collectGlobalStats } from "../stats/global.js";
import { logger } from "../logging/index.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
}

/**
 * Run the local dashboard web server. Blocks until the server is closed.
 */
export async function runDashboard(opts: DashboardOptions = {}): Promise<void> {
  const port = opts.port ?? 7878;
  // Bind to loopback only. The dashboard exposes project stats and decisions,
  // so it must never be reachable from the local network. Visit it at
  // http://127.0.0.1:7878 (use 127.0.0.1, not "localhost", to avoid IPv6
  // resolution issues on some Windows setups).
  const host = opts.host ?? "127.0.0.1";
  const warden = await Warden.create();

  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }

      if (req.url === "/api/status") {
        const status = warden.status();
        const budgets = budgetReport();
        const totalSaved = warden.totalTokensSaved();
        const projectName = warden.repoRoot
          ? warden.repoRoot.split(/[/\\]/).pop() || "unknown"
          : "global";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            totalTokensSaved: totalSaved,
            projectName,
            projectPath: warden.repoRoot ?? "~/.warden",
            rules: status.map((s) => ({
              ruleId: s.ruleId,
              name: s.name,
              toolType: s.toolType,
              stage: s.stage,
              confidence: s.confidence,
              samples: s.samples,
              decaying: s.decaying,
              daysSinceLastRun: s.daysSinceLastRun,
            })),
            budgets,
          }),
        );
        return;
      }

      if (req.url === "/api/decisions") {
        const decisions = warden.store.recentDecisions(50);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            decisions.map((d) => {
              let detail: unknown = d.detail_json;
              try {
                detail = JSON.parse(d.detail_json);
              } catch {
                // keep raw string if malformed
              }
              return {
                timestamp: d.timestamp,
                kind: d.kind,
                ruleId: d.rule_id,
                toolType: d.tool_type,
                tokensSaved: d.tokens_saved,
                detail,
              };
            }),
          ),
        );
        return;
      }

      if (req.url === "/api/watchdog") {
        const result = await runWatchdogTiered(warden);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === "/api/global") {
        const global = await collectGlobalStats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(global));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      logger.warn("dashboard request error", { err: String(err) });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  });

  server.listen(port, host, () => {
    logger.info("warden dashboard running", { host, port });
    process.stderr.write(
      `\n  Warden Dashboard — http://${host}:${port}\n\n` +
        `  Press Ctrl+C to stop.\n\n`,
    );
  });

  return new Promise((resolve) => {
    const cleanup = () => {
      warden.close();
      server.close();
      resolve();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    server.on("close", cleanup);
  });
}

/** The dashboard HTML — a single-page app that polls /api/status. */
function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warden Dashboard</title>
<style>
  :root {
    --bg: #0a0a0a; --surface: #141414; --border: #222; --text: #e0e0e0;
    --dim: #888; --accent: #00ff88; --warn: #daa036; --crit: #ff4444;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--mono); padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin: 24px 0 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  .license-badge { background: var(--accent); color: var(--bg); padding: 4px 12px; border-radius: 4px; font-weight: bold; font-size: 0.85rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-label { color: var(--dim); font-size: 0.8rem; text-transform: uppercase; margin-bottom: 8px; }
  .stat-value { font-size: 1.8rem; font-weight: bold; }
  .stat-value.green { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  th { color: var(--dim); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 1px; }
  .stage { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
  .stage-shadow { background: #333; color: var(--dim); }
  .stage-canary { background: #1a1a3a; color: #6688ff; }
  .stage-active { background: #0a2a0a; color: var(--accent); }
  .stage-reverted { background: #2a0a0a; color: var(--crit); }
  .conf-bar { width: 100px; height: 6px; background: #333; border-radius: 3px; overflow: hidden; display: inline-block; vertical-align: middle; }
  .conf-fill { height: 100%; background: var(--accent); transition: width 0.5s; }
  .conf-fill.warn { background: var(--warn); }
  .conf-fill.crit { background: var(--crit); }
  .decisions { max-height: 400px; overflow-y: auto; }
  .kind-prune { color: var(--accent); }
  .kind-promote { color: #6688ff; }
  .kind-revert { color: var(--crit); }
  .kind-observe { color: var(--dim); }
  .budget-exceeded { color: var(--crit); font-weight: bold; }
  .refresh-note { color: var(--dim); font-size: 0.75rem; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Warden Dashboard</h1>
    <div class="refresh-note" id="project-name">Loading...</div>
  </div>
  <div id="license-badge" class="license-badge">Warden</div>
</div>

<h2>This Project</h2>
<div class="stats" id="stats"></div>

<h2>All Projects (Overall)</h2>
<div class="stats" id="global-stats"></div>

<h2>Savings Over Time</h2>
<table id="time-table">
  <thead><tr><th>Period</th><th>Tokens Saved</th><th>Tokens Processed</th><th>Reduction</th><th>Calls</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Per-Project Breakdown</h2>
<table id="projects-table">
  <thead><tr><th>Project</th><th>Tokens Saved</th><th>Tokens Processed</th><th>Reduction</th><th>Rules (A/S)</th><th>Memories</th><th>Outcomes</th><th>Success</th><th>Last Activity</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Pruning Rules (This Project)</h2>
<table id="rules-table">
  <thead><tr><th>Rule</th><th>Tool</th><th>Stage</th><th>Confidence</th><th>Samples</th><th>Status</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Budget Caps</h2>
<div id="budgets"></div>

<h2>Recent Decisions (This Project)</h2>
<table class="decisions" id="decisions-table">
  <thead><tr><th>Time</th><th>Kind</th><th>Rule</th><th>Tokens Saved</th><th>Details</th></tr></thead>
  <tbody></tbody>
</table>

<script>
async function poll() {
  try {
    const [statusRes, decRes, globalRes] = await Promise.all([
      fetch('/api/status'), fetch('/api/decisions'), fetch('/api/global')
    ]);
    const status = await statusRes.json();
    const decisions = await decRes.json();
    const global = await globalRes.json();
    render(status, decisions, global);
  } catch (e) { console.error('poll failed', e); }
}

function render(status, decisions, global) {
  document.getElementById('license-badge').textContent = 'Warden';
  document.getElementById('project-name').textContent =
    'Project: ' + (status.projectName || 'global') +
    ' — Auto-refreshing every 3s';

  // Per-project stats
  const statsHtml = [
    statCard('Tokens Saved (This Project)', status.totalTokensSaved.toLocaleString(), 'green'),
    statCard('Active Rules', status.rules.filter(r => r.stage === 'active').length, ''),
    statCard('Shadow Rules', status.rules.filter(r => r.stage === 'shadow').length, ''),
    statCard('Reverted Rules', status.rules.filter(r => r.stage === 'reverted').length, ''),
  ].join('');
  document.getElementById('stats').innerHTML = statsHtml;

  // Global stats
  const globalHtml = [
    statCard('Tokens Saved (All Projects)', global.totalTokensSaved.toLocaleString(), 'green'),
    statCard('Tokens Processed (All)', global.totalTokensProcessed.toLocaleString(), ''),
    statCard('Overall Reduction', global.overallReductionPct + '%', 'green'),
    statCard('Projects Tracked', global.projectCount, ''),
    statCard('Total Memories', global.totalMemories, ''),
    statCard('Overall Success Rate', global.overallSuccessRate + '%', ''),
  ].join('');
  document.getElementById('global-stats').innerHTML = globalHtml;

  // Time-based breakdown
  const timeBody = document.querySelector('#time-table tbody');
  if (global.today && global.last7days && global.allTime) {
    timeBody.innerHTML = [
      ['Today', global.today],
      ['Last 7 days', global.last7days],
      ['All time', global.allTime],
    ].map(([label, t]) => {
      return '<tr>' +
        '<td>' + label + '</td>' +
        '<td>' + t.tokensSaved.toLocaleString() + '</td>' +
        '<td>' + t.tokensProcessed.toLocaleString() + '</td>' +
        '<td>' + t.reductionPct + '%</td>' +
        '<td>' + t.calls + '</td>' +
      '</tr>';
    }).join('');
  }

  // Per-project breakdown table
  const projBody = document.querySelector('#projects-table tbody');
  projBody.innerHTML = global.projects.map(p => {
    const lastAct = p.lastActivity ? new Date(p.lastActivity).toLocaleString() : '-';
    return '<tr>' +
      '<td>' + esc(p.projectName) + '</td>' +
      '<td>' + p.tokensSaved.toLocaleString() + '</td>' +
      '<td>' + p.tokensProcessed.toLocaleString() + '</td>' +
      '<td>' + p.reductionPct + '%</td>' +
      '<td>' + p.rulesActive + '/' + p.rulesShadow + '</td>' +
      '<td>' + p.memoriesCount + '</td>' +
      '<td>' + p.outcomesCount + '</td>' +
      '<td>' + p.successRate + '%</td>' +
      '<td style="color:var(--dim);font-size:0.75rem">' + lastAct + '</td>' +
    '</tr>';
  }).join('');

  const rulesBody = document.querySelector('#rules-table tbody');
  rulesBody.innerHTML = status.rules.map(r => {
    const confPct = (r.confidence * 100).toFixed(0);
    const confClass = r.confidence >= 0.9 ? '' : r.confidence >= 0.7 ? 'warn' : 'crit';
    const statusText = r.decaying ? 'decaying' : r.stage === 'active' ? 'live' : r.stage;
    return '<tr>' +
      '<td>' + esc(r.ruleId) + '</td>' +
      '<td>' + esc(r.toolType) + '</td>' +
      '<td><span class="stage stage-' + esc(r.stage) + '">' + esc(r.stage) + '</span></td>' +
      '<td><div class="conf-bar"><div class="conf-fill ' + confClass + '" style="width:' + confPct + '%"></div></div> ' + confPct + '%</td>' +
      '<td>' + r.samples + '</td>' +
      '<td>' + statusText + '</td>' +
    '</tr>';
  }).join('');

  const budgetsDiv = document.getElementById('budgets');
  if (status.budgets && status.budgets.length > 0) {
    budgetsDiv.innerHTML = '<table><thead><tr><th>Scope</th><th>Spent</th><th>Cap</th><th>Utilization</th><th>Status</th></tr></thead><tbody>' +
      status.budgets.map(b => {
        const pct = (b.spent / b.cap * 100).toFixed(1);
        const exceeded = b.exceeded;
        return '<tr>' +
          '<td>' + esc(b.scope) + '</td>' +
          '<td>' + b.spent.toLocaleString() + '</td>' +
          '<td>' + b.cap.toLocaleString() + '</td>' +
          '<td>' + pct + '%</td>' +
          '<td class="' + (exceeded ? 'budget-exceeded' : '') + '">' + (exceeded ? 'EXCEEDED' : 'OK') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  } else {
    budgetsDiv.innerHTML = '<p class="refresh-note">No budget caps configured. Use <code>warden budget set &lt;scope&gt; &lt;tokens&gt;</code> to add one.</p>';
  }

  const decBody = document.querySelector('#decisions-table tbody');
  decBody.innerHTML = decisions.slice(0, 30).map(d => {
    const time = new Date(d.timestamp).toLocaleTimeString();
    return '<tr>' +
      '<td>' + time + '</td>' +
      '<td class="kind-' + esc(d.kind) + '">' + esc(d.kind) + '</td>' +
      '<td>' + esc(d.ruleId || '-') + '</td>' +
      '<td>' + d.tokensSaved + '</td>' +
      '<td style="color:var(--dim);font-size:0.75rem">' + esc(JSON.stringify(d.detail).slice(0, 80)) + '</td>' +
    '</tr>';
  }).join('');
}

// Escape untrusted strings (project names, rule ids, detail blobs) before
// they go into innerHTML. The dashboard is localhost-only and single-user,
// but escaping is cheap and prevents a weird repo/rule name from breaking
// the page or injecting markup.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statCard(label, value, cls) {
  return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value ' + cls + '">' + value + '</div></div>';
}

poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;
}

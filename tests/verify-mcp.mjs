import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbPath = join(tmpdir(), "warden-mcp-verify-" + Date.now() + ".db");
if (existsSync(dbPath)) rmSync(dbPath);

const env = { ...process.env, WARDEN_DB_PATH: dbPath };

// Spawn the MCP server
const proc = spawn("node", ["C:/Users/Hubby/Desktop/warden/dist/cli.js", "serve"], {
  stdio: ["pipe", "pipe", "pipe"],
  env,
});

let stdout = "";
let stderr = "";
proc.stdout.on("data", (d) => { stdout += d.toString(); });
proc.stderr.on("data", (d) => { stderr += d.toString(); });

// Helper to send a JSON-RPC message
function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

// Wait for responses
function waitForResponse(id, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            resolve(parsed);
            return;
          }
        }
      } catch {}
      if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for response id=" + id));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function run() {
  const results = [];

  // 1. Initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });

  const initResp = await waitForResponse(1);
  const initOk = initResp.result?.serverInfo?.name === "warden" &&
    initResp.result?.protocolVersion === "2024-11-05";
  results.push({
    test: "initialize",
    status: initOk ? "PASS" : "FAIL",
    detail: `server=${initResp.result?.serverInfo?.name}, protocol=${initResp.result?.protocolVersion}`,
  });

  // Send initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. List tools
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResp = await waitForResponse(2);
  const tools = toolsResp.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name);
  const expectedTools = ["warden_status", "warden_grep", "warden_file_read", "warden_index", "warden_call_graph"];
  const hasAllExpected = expectedTools.every((t) => toolNames.includes(t));
  results.push({
    test: "tools/list",
    status: tools.length >= 20 && hasAllExpected ? "PASS" : "FAIL",
    detail: `${tools.length} tools exposed, expected tools present: ${hasAllExpected}`,
  });

  // 3. Call warden_status
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "warden_status", arguments: {} } });
  const statusResp = await waitForResponse(3);
  const statusText = statusResp.result?.content?.[0]?.text ?? "";
  const statusOk = statusText.toLowerCase().includes("warden") && statusText.toLowerCase().includes("tokens");
  results.push({
    test: "tools/call warden_status",
    status: statusOk ? "PASS" : "FAIL",
    detail: statusText.substring(0, 80) + "...",
  });

  // 4. Call warden_memory_save
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "warden_memory_save",
      arguments: {
        category: "decision",
        title: "Test decision from MCP verify",
        body: "This is a test memory entry to verify the MCP server works.",
        tags: ["test", "verify"],
      },
    },
  });
  const memResp = await waitForResponse(4);
  const memText = memResp.result?.content?.[0]?.text ?? "";
  const memOk = memText.includes("saved") || memText.includes("Memory");
  results.push({
    test: "tools/call warden_memory_save",
    status: memOk ? "PASS" : "FAIL",
    detail: memText.substring(0, 80),
  });

  // 5. Call warden_memory_list
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "warden_memory_list", arguments: {} } });
  const listResp = await waitForResponse(5);
  const listText = listResp.result?.content?.[0]?.text ?? "";
  const listOk = listText.includes("Test decision") || listText.length > 10;
  results.push({
    test: "tools/call warden_memory_list",
    status: listOk ? "PASS" : "FAIL",
    detail: listText.substring(0, 80),
  });

  // Print results
  console.log("\n=== MCP Server Verification ===\n");
  let pass = 0, fail = 0;
  for (const r of results) {
    const icon = r.status === "PASS" ? "OK  " : "FAIL";
    console.log(`  [${icon}] ${r.test.padEnd(30)} ${r.detail}`);
    if (r.status === "PASS") pass++;
    else fail++;
  }
  console.log(`\n  Total: ${results.length} | Pass: ${pass} | Fail: ${fail}`);

  // Cleanup
  proc.kill();
  try { rmSync(dbPath); } catch {}

  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal error:", e.message);
  console.error("stderr:", stderr);
  proc.kill();
  process.exit(1);
});

/**
 * Full integration test — simulates an agent working in the warden codebase.
 * Calls the actual MCP tools (warden_grep, warden_file_read, warden_run_tests,
 * warden_run_command, warden_index, warden_architecture) and measures real
 * token savings.
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const CLI = "C:\\Users\\Hubby\\Desktop\\warden\\dist\\cli.js";
const CWD = "C:\\Users\\Hubby\\Desktop\\warden";

// JSON-RPC over stdio helper
function callMcpTool(toolName, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI, "serve"], {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    const results = [];

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            results.push(msg);
          }
        } catch {}
      }
    });

    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0" },
      },
    }) + "\n";

    const toolCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }) + "\n";

    proc.stdin.write(initMsg);
    proc.stdin.write(toolCall);

    const timer = setTimeout(() => {
      proc.stdin.end();
      proc.kill();
    }, timeoutMs);

    proc.on("close", () => {
      clearTimeout(timer);
      const toolResult = results.find((r) => r.id === 1);
      if (toolResult) {
        resolve(toolResult);
      } else {
        reject(new Error("No result. stderr: " + stderr.slice(0, 500)));
      }
    });
  });
}

function extractText(result) {
  if (!result?.result?.content) return "";
  return result.result.content.map((c) => c.text || "").join("\n");
}

function countTokens(text) {
  return Math.ceil(text.length / 4);
}

async function runTest() {
  console.log("=== Warden Full Integration Test ===\n");
  console.log(`Project: ${CWD}\n`);

  const tests = [];
  let totalRaw = 0;
  let totalPruned = 0;

  // Test 1: warden_grep — search for "function" across all TS files
  console.log("Test 1: warden_grep — search 'export' in src/");
  try {
    const result = await callMcpTool("warden_grep", {
      pattern: "export",
      path: "src",
      glob: "*.ts",
      maxResults: 100,
    });
    const text = extractText(result);
    const tokens = countTokens(text);
    // Check for warden annotation
    const hasAnnotation = text.includes("‹warden");
    const annotationMatch = text.match(/full=(\d+)\s+pruned=(\d+)\s+saved=(\d+)/);
    const full = annotationMatch ? parseInt(annotationMatch[1]) : tokens;
    const pruned = annotationMatch ? parseInt(annotationMatch[2]) : tokens;
    const saved = annotationMatch ? parseInt(annotationMatch[3]) : 0;
    totalRaw += full;
    totalPruned += pruned;
    tests.push({
      test: "warden_grep 'export' in src/",
      fullTokens: full,
      prunedTokens: pruned,
      savedTokens: saved,
      reductionPct: full > 0 ? Math.round((saved / full) * 100) : 0,
      hasAnnotation,
      outputLines: text.split("\n").length,
    });
    console.log(`  Full: ${full}, Pruned: ${pruned}, Saved: ${saved} (${full > 0 ? Math.round((saved / full) * 100) : 0}%)`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    tests.push({ test: "warden_grep", error: e.message });
  }

  // Test 2: warden_file_read — read a large file
  console.log("\nTest 2: warden_file_read — read src/server/mcp.ts");
  try {
    const result = await callMcpTool("warden_file_read", {
      filePath: "src/server/mcp.ts",
    });
    const text = extractText(result);
    const tokens = countTokens(text);
    const hasAnnotation = text.includes("‹warden");
    const annotationMatch = text.match(/full=(\d+)\s+pruned=(\d+)\s+saved=(\d+)/);
    const full = annotationMatch ? parseInt(annotationMatch[1]) : tokens;
    const pruned = annotationMatch ? parseInt(annotationMatch[2]) : tokens;
    const saved = annotationMatch ? parseInt(annotationMatch[3]) : 0;
    totalRaw += full;
    totalPruned += pruned;
    tests.push({
      test: "warden_file_read src/server/mcp.ts",
      fullTokens: full,
      prunedTokens: pruned,
      savedTokens: saved,
      reductionPct: full > 0 ? Math.round((saved / full) * 100) : 0,
      hasAnnotation,
      outputLines: text.split("\n").length,
    });
    console.log(`  Full: ${full}, Pruned: ${pruned}, Saved: ${saved} (${full > 0 ? Math.round((saved / full) * 100) : 0}%)`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    tests.push({ test: "warden_file_read", error: e.message });
  }

  // Test 3: warden_run_tests — run the test suite
  console.log("\nTest 3: warden_run_tests — npm test");
  try {
    const result = await callMcpTool("warden_run_tests", {
      command: "npx vitest run --reporter=verbose 2>&1",
    }, 120000);
    const text = extractText(result);
    const tokens = countTokens(text);
    const hasAnnotation = text.includes("‹warden");
    const annotationMatch = text.match(/full=(\d+)\s+pruned=(\d+)\s+saved=(\d+)/);
    const full = annotationMatch ? parseInt(annotationMatch[1]) : tokens;
    const pruned = annotationMatch ? parseInt(annotationMatch[2]) : tokens;
    const saved = annotationMatch ? parseInt(annotationMatch[3]) : 0;
    totalRaw += full;
    totalPruned += pruned;
    tests.push({
      test: "warden_run_tests npm test",
      fullTokens: full,
      prunedTokens: pruned,
      savedTokens: saved,
      reductionPct: full > 0 ? Math.round((saved / full) * 100) : 0,
      hasAnnotation,
      outputLines: text.split("\n").length,
    });
    console.log(`  Full: ${full}, Pruned: ${pruned}, Saved: ${saved} (${full > 0 ? Math.round((saved / full) * 100) : 0}%)`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    tests.push({ test: "warden_run_tests", error: e.message });
  }

  // Test 4: warden_run_command — run a build
  console.log("\nTest 4: warden_run_command — npm run build");
  try {
    const result = await callMcpTool("warden_run_command", {
      command: "npm run build 2>&1",
    });
    const text = extractText(result);
    const tokens = countTokens(text);
    const hasAnnotation = text.includes("‹warden");
    const annotationMatch = text.match(/full=(\d+)\s+pruned=(\d+)\s+saved=(\d+)/);
    const full = annotationMatch ? parseInt(annotationMatch[1]) : tokens;
    const pruned = annotationMatch ? parseInt(annotationMatch[2]) : tokens;
    const saved = annotationMatch ? parseInt(annotationMatch[3]) : 0;
    totalRaw += full;
    totalPruned += pruned;
    tests.push({
      test: "warden_run_command npm run build",
      fullTokens: full,
      prunedTokens: pruned,
      savedTokens: saved,
      reductionPct: full > 0 ? Math.round((saved / full) * 100) : 0,
      hasAnnotation,
      outputLines: text.split("\n").length,
    });
    console.log(`  Full: ${full}, Pruned: ${pruned}, Saved: ${saved} (${full > 0 ? Math.round((saved / full) * 100) : 0}%)`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    tests.push({ test: "warden_run_command", error: e.message });
  }

  // Test 5: warden_index + warden_architecture
  console.log("\nTest 5: warden_index + warden_architecture");
  try {
    const indexResult = await callMcpTool("warden_index", { repoRoot: "." }, 60000);
    const indexText = extractText(indexResult);
    console.log(`  Index: ${indexText.slice(0, 200)}`);

    const archResult = await callMcpTool("warden_architecture", {});
    const archText = extractText(archResult);
    const archTokens = countTokens(archText);
    tests.push({
      test: "warden_architecture",
      fullTokens: archTokens,
      prunedTokens: archTokens,
      savedTokens: 0,
      reductionPct: 0,
      hasAnnotation: false,
      outputLines: archText.split("\n").length,
    });
    console.log(`  Architecture output: ${archTokens} tokens, ${archText.split("\n").length} lines`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    tests.push({ test: "warden_architecture", error: e.message });
  }

  // Summary
  console.log("\n=== Summary ===\n");
  console.log("Test                              | Full    | Pruned  | Saved   | Reduction");
  console.log("----------------------------------|---------|---------|---------|----------");
  for (const t of tests) {
    if (t.error) {
      console.log(`${t.test.padEnd(34)}| ERROR`);
    } else {
      console.log(`${t.test.padEnd(34)}| ${String(t.fullTokens).padStart(7)} | ${String(t.prunedTokens).padStart(7)} | ${String(t.savedTokens).padStart(7)} | ${t.reductionPct}%`);
    }
  }
  console.log("----------------------------------|---------|---------|---------|----------");
  const totalSaved = totalRaw - totalPruned;
  const totalPct = totalRaw > 0 ? Math.round((totalSaved / totalRaw) * 100) : 0;
  console.log(`${"TOTAL".padEnd(34)}| ${String(totalRaw).padStart(7)} | ${String(totalPruned).padStart(7)} | ${String(totalSaved).padStart(7)} | ${totalPct}%`);

  // Write results to file
  writeFileSync("test-results.json", JSON.stringify({ tests, totalRaw, totalPruned, totalSaved, totalPct }, null, 2));
  console.log(`\nResults saved to test-results.json`);
}

runTest().catch(console.error);

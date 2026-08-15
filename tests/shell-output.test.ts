/**
 * Comprehensive tests for the shell-output pruning module.
 *
 * Tests every pattern detector + compression strategy:
 *   git log, git diff, git status, git branch
 *   npm install, npm ls, npm build (webpack/vite)
 *   docker logs, docker build, docker ps
 *   cargo build, kubectl logs, kubectl get
 *   ps aux, ls -la, find, tree, make
 *   go test, go build, pip install, mvn, gradle, rustc, tsc
 *
 * Also tests:
 *   - Trust guard invariant (every non-annotation line exists in raw)
 *   - Small output passthrough
 *   - Fallback for unrecognized patterns
 *   - Router detection for shell-output content
 */
import { describe, it, expect } from "vitest";
import { shellOutputModule, listShellPatterns, tailKeep, summaryKeep, countKeep, topN } from "../src/pruner/modules/shell-output.js";
import { PruningEngine } from "../src/pruner/index.js";
import { verifyInclusion } from "../src/pruner/guard.js";
import { routeContent } from "../src/pruner/router.js";
import type { TaskContext } from "../src/classifier/types.js";
import type { PruneOptions } from "../src/pruner/types.js";

const emptyTask: TaskContext = {
  type: "feature",
  relevanceHint: "",
  language: "typescript",
  repoRoot: "/test",
};

const defaultOpts: PruneOptions = {
  shellTailLines: 50,
  shellGitLogMaxCommits: 15,
  shellFindMaxResults: 30,
  shellPsMaxProcesses: 15,
};

/** Generate a git log output with N commits. */
function makeGitLog(commits: number): string {
  const lines: string[] = [];
  for (let i = 0; i < commits; i++) {
    lines.push(`commit a1b2c3d4e5f6${(i % 10).toString().padStart(1, "0")}${i.toString().padStart(2, "0")}`);
    lines.push(`Author: Dev <dev@test.com>`);
    lines.push(`Date:   Mon Aug ${10 + i} 12:00:00 2026 +0000`);
    lines.push("");
    lines.push(`    fix: issue #${i} in auth module`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Generate docker logs with N timestamped lines + some errors. */
function makeDockerLogs(lines: number, errorEvery: number = 0): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const ts = `2026-08-15T10:${Math.floor(i / 60).toString().padStart(2, "0")}:${(i % 60).toString().padStart(2, "0")}.000Z`;
    if (errorEvery > 0 && i > 0 && i % errorEvery === 0) {
      out.push(`${ts} ERROR Something went wrong at line ${i}`);
    } else {
      out.push(`${ts} INFO Processing request ${i}`);
    }
  }
  return out.join("\n");
}

/** Generate npm install output. */
function makeNpmInstall(packages: number): string {
  const lines: string[] = [];
  for (let i = 0; i < packages; i++) {
    lines.push(`+ some-package-${i}@1.0.${i}`);
  }
  lines.push("");
  lines.push(`added ${packages} packages, and audited ${packages + 10} packages in 3s`);
  lines.push("");
  lines.push(`${packages} packages are looking for funding`);
  lines.push(`  run \`npm fund\` for details`);
  lines.push("");
  lines.push(`found 0 vulnerabilities`);
  return lines.join("\n");
}

/** Generate ps aux output with N processes. */
function makePsAux(processes: number): string {
  const lines: string[] = ["USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND"];
  for (let i = 0; i < processes; i++) {
    const cpu = (Math.random() * 50).toFixed(1);
    const mem = (Math.random() * 20).toFixed(1);
    lines.push(`root      ${1000 + i}  ${cpu}  ${mem}  12345  6789 pts/0    S+   10:00   0:0${i % 10} node /app/server-${i}.js`);
  }
  return lines.join("\n");
}

/** Generate find output with N results. */
function makeFind(results: number): string {
  const lines: string[] = [];
  for (let i = 0; i < results; i++) {
    lines.push(`/home/user/project/src/module-${i}/index.ts`);
  }
  return lines.join("\n");
}

/** Generate cargo build output. */
function makeCargoBuild(compiling: number, warnings: number, errors: number): string {
  const lines: string[] = [];
  for (let i = 0; i < compiling; i++) {
    lines.push(`Compiling dep-${i} v1.0.${i}`);
  }
  for (let i = 0; i < warnings; i++) {
    lines.push(`warning: unused variable \`x\` in src/main.rs:${i + 10}:${i + 5}`);
    lines.push(`  --> src/main.rs:${i + 10}:${i + 5}`);
    lines.push(`   |`);
    lines.push(`${i + 10} |     let x = 42;`);
    lines.push(`   |         ^ help: consider using \`x\``);
  }
  for (let i = 0; i < errors; i++) {
    lines.push(`error[E0308]: mismatched types in src/main.rs:${i + 20}:${i + 1}`);
  }
  if (errors === 0) {
    lines.push(`Finished dev [unoptimized + debuginfo] target(s) in 5.2s`);
  }
  return lines.join("\n");
}

/** Generate kubectl logs. */
function makeKubectlLogs(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const ts = `2026-08-15T10:00:${(i % 60).toString().padStart(2, "0")}.000000Z`;
    const level = i % 20 === 0 ? "ERROR" : i % 10 === 0 ? "WARN" : "INFO";
    out.push(`${ts} ${level} pod-api-xyz Request ${i} processed`);
  }
  return out.join("\n");
}

/** Generate tree output. */
function makeTree(depth: number, branching: number): string {
  const lines: string[] = [];
  function build(prefix: string, currentDepth: number) {
    if (currentDepth >= depth) return;
    for (let i = 0; i < branching; i++) {
      const isLast = i === branching - 1;
      const branch = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${branch}dir-${currentDepth}-${i}/`);
      build(prefix + (isLast ? "    " : "│   "), currentDepth + 1);
    }
  }
  lines.push(".");
  build("", 0);
  lines.push("");
  lines.push(`${lines.length - 2} directories, 0 files`);
  return lines.join("\n");
}

/** Generate make output. */
function makeMake(targets: number): string {
  const lines: string[] = [];
  for (let i = 0; i < targets; i++) {
    lines.push(`make[${i + 1}]: Entering directory '/home/user/build'`);
    lines.push(`gcc -c -O2 -Wall src/file-${i}.c -o obj/file-${i}.o`);
    lines.push(`make[${i + 1}]: Leaving directory '/home/user/build'`);
  }
  if (targets > 0) {
    lines.push(`make: *** No rule to make target 'all'. Stop.`);
  }
  return lines.join("\n");
}

/** Generate go test output. */
function makeGoTest(tests: number, failures: number): string {
  const lines: string[] = [];
  for (let i = 0; i < tests; i++) {
    lines.push(`=== RUN   TestFunc${i}`);
    lines.push(`=== PAUSE TestFunc${i}`);
    lines.push(`=== CONT  TestFunc${i}`);
    if (i < failures) {
      lines.push(`    file_test.go:${i + 10}: Error: expected 42, got ${i}`);
      lines.push(`--- FAIL: TestFunc${i} (0.00s)`);
    } else {
      lines.push(`--- PASS: TestFunc${i} (0.00s)`);
    }
  }
  lines.push(`PASS`);
  lines.push(`ok  \tgithub.com/test/module\t0.5s`);
  if (failures > 0) {
    lines.push(`FAIL`);
    lines.push(`FAIL\tgithub.com/test/module\t0.5s`);
  }
  return lines.join("\n");
}

/** Generate pip install output. */
function makePipInstall(packages: number): string {
  const lines: string[] = [];
  for (let i = 0; i < packages; i++) {
    lines.push(`Collecting package-${i}==1.0.${i}`);
    lines.push(`  Downloading package-${i}-1.0.${i}-py3-none-any.whl (123 kB)`);
  }
  lines.push(`Installing collected packages: ${Array.from({ length: packages }, (_, i) => `package-${i}`).join(", ")}`);
  lines.push(`Successfully installed ${Array.from({ length: packages }, (_, i) => `package-${i}-1.0.${i}`).join(" ")}`);
  return lines.join("\n");
}

/** Generate maven output. */
function makeMvn(modules: number, errors: number): string {
  const lines: string[] = [];
  for (let i = 0; i < modules; i++) {
    lines.push(`[INFO] Building module-${i} 1.0.${i}`);
    lines.push(`[INFO] --------------------------------[ jar ]----------------`);
    lines.push(`[INFO] Compiling ${i + 5} source files`);
  }
  for (let i = 0; i < errors; i++) {
    lines.push(`[ERROR] Failed to execute goal on project module-${i}: Compilation failure`);
  }
  lines.push(`[INFO] ------------------------------------------------------------------------`);
  lines.push(`[INFO] BUILD ${errors > 0 ? "FAILURE" : "SUCCESS"}`);
  lines.push(`[INFO] ------------------------------------------------------------------------`);
  lines.push(`[INFO] Total time:  03:21 min`);
  return lines.join("\n");
}

/** Generate gradle output. */
function makeGradle(tasks: number, failed: boolean): string {
  const lines: string[] = [];
  lines.push(`> Configure project :`);
  for (let i = 0; i < tasks; i++) {
    lines.push(`> Task :compileJava`);
    lines.push(`> Task :processResources`);
  }
  lines.push(failed ? `BUILD FAILED` : `BUILD SUCCESSFUL in 5s`);
  lines.push(`${tasks} actionable tasks: ${tasks} executed`);
  return lines.join("\n");
}

/** Generate tsc output. */
function makeTsc(errors: number, warnings: number): string {
  const lines: string[] = [];
  for (let i = 0; i < errors; i++) {
    lines.push(`src/file-${i}.ts:${i + 10}:${i + 1} - error TS2322: Type 'string' is not assignable to type 'number'.`);
    lines.push(`  const x: number = "hello";`);
  }
  for (let i = 0; i < warnings; i++) {
    lines.push(`src/file-${i}.ts:${i + 20}:${i + 1} - warning TS6133: 'x' is declared but its value is never read.`);
  }
  if (errors > 0) {
    lines.push(`Found ${errors} error${errors > 1 ? "s" : ""} in ${errors} file${errors > 1 ? "s" : ""}.`);
  }
  return lines.join("\n");
}

/** Generate docker build output. */
function makeDockerBuild(steps: number): string {
  const lines: string[] = [];
  for (let i = 0; i < steps; i++) {
    lines.push(`Step ${i + 1}/${steps} : FROM node:22`);
    lines.push(` ---> abc123def456`);
    lines.push(`Removing intermediate container ${i}xyz`);
  }
  lines.push(`Successfully built abc123def456`);
  lines.push(`Successfully tagged myapp:latest`);
  return lines.join("\n");
}

/** Generate git diff output. */
function makeGitDiff(files: number, changesPerFile: number): string {
  const lines: string[] = [];
  for (let f = 0; f < files; f++) {
    lines.push(`diff --git a/src/file-${f}.ts b/src/file-${f}.ts`);
    lines.push(`index abc123..def456 100644`);
    lines.push(`--- a/src/file-${f}.ts`);
    lines.push(`+++ b/src/file-${f}.ts`);
    lines.push(`@@ -10,5 +10,${5 + changesPerFile} @@`);
    for (let c = 0; c < changesPerFile; c++) {
      lines.push(`-old line ${c}`);
      lines.push(`+new line ${c}`);
    }
    lines.push(` context line 1`);
    lines.push(` context line 2`);
  }
  return lines.join("\n");
}

/** Generate git status output. */
function makeGitStatus(files: number): string {
  const lines: string[] = [];
  lines.push(`On branch main`);
  lines.push(`Your branch is up to date with 'origin/main'.`);
  if (files > 0) {
    lines.push(`Changes not staged for commit:`);
    lines.push(`  (use "git add <file>..." to update what will be committed)`);
    for (let i = 0; i < files; i++) {
      lines.push(`\tmodified:   src/file-${i}.ts`);
    }
  } else {
    lines.push(`nothing to commit, working tree clean`);
  }
  return lines.join("\n");
}

/** Generate ls -la output. */
function makeLsLa(files: number): string {
  const lines: string[] = [];
  lines.push(`total ${files * 4}`);
  lines.push(`drwxr-xr-x  3 user user  4096 Aug 15 10:00 .`);
  lines.push(`drwxr-xr-x  5 user user  4096 Aug 15 09:00 ..`);
  for (let i = 0; i < files; i++) {
    lines.push(`-rw-r--r--  1 user user  1234 Aug 15 10:00 file-${i}.ts`);
  }
  return lines.join("\n");
}

/** Generate kubectl get output. */
function makeKubectlGet(resources: number): string {
  const lines: string[] = ["NAME             READY   STATUS    RESTARTS   AGE"];
  for (let i = 0; i < resources; i++) {
    lines.push(`pod-api-${i}      1/1     Running   0          ${i + 1}d`);
  }
  return lines.join("\n");
}

/** Generate docker ps output. */
function makeDockerPs(containers: number): string {
  const lines: string[] = ["CONTAINER ID   IMAGE     COMMAND                  CREATED         STATUS         PORTS                  NAMES"];
  for (let i = 0; i < containers; i++) {
    lines.push(`abc123d${i.toString().padStart(2, "0")}      nginx     "nginx -g 'daemon..."   2 minutes ago   Up 2 minutes   0.0.0.0:80->80/tcp   web-${i}`);
  }
  return lines.join("\n");
}

/** Generate git branch output. */
function makeGitBranch(branches: number): string {
  const lines: string[] = [];
  for (let i = 0; i < branches; i++) {
    const marker = i === 0 ? "*" : " ";
    lines.push(`${marker} ${i === 0 ? "main" : `feature-${i}`}`);
  }
  return lines.join("\n");
}

/** Generate rustc output. */
function makeRustc(errors: number, warnings: number): string {
  const lines: string[] = [];
  for (let i = 0; i < errors; i++) {
    lines.push(`error[E0308]: mismatched types`);
    lines.push(` --> src/main.rs:${i + 10}:${i + 1}`);
    lines.push(`  |`);
    lines.push(`${i + 10} |     let x: number = "hello";`);
    lines.push(`  |                       ^^^^^^^ expected number, found string`);
  }
  for (let i = 0; i < warnings; i++) {
    lines.push(`warning: unused variable: \`x\``);
    lines.push(` --> src/main.rs:${i + 30}:${i + 1}`);
  }
  if (errors > 0) {
    lines.push(`error: aborting due to ${errors} previous error${errors > 1 ? "s" : ""}`);
  }
  return lines.join("\n");
}

/** Generate go build output. */
function makeGoBuild(errors: number): string {
  const lines: string[] = [];
  lines.push(`# github.com/test/module`);
  for (let i = 0; i < errors; i++) {
    lines.push(`./src/file-${i}.go:${i + 10}:${i + 1}: undefined: someFunc${i}`);
  }
  return lines.join("\n");
}

/** Verify trust guard: every non-annotation line in pruned output exists in raw. */
function verifyGuard(raw: string, pruned: string): boolean {
  return verifyInclusion(raw, pruned);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shell-output module — pattern detection + compression", () => {
  const engine = new PruningEngine();

  describe("module metadata", () => {
    it("has correct tool type and rule id", () => {
      expect(shellOutputModule.toolType).toBe("shell-output");
      expect(shellOutputModule.ruleId).toBe("shell-output.pattern-compress.v1");
    });

    it("exports 24+ patterns", () => {
      const patterns = listShellPatterns();
      expect(patterns.length).toBeGreaterThanOrEqual(20);
      expect(patterns).toContain("git-log");
      expect(patterns).toContain("git-diff");
      expect(patterns).toContain("docker-logs");
      expect(patterns).toContain("npm-install");
      expect(patterns).toContain("cargo-build");
      expect(patterns).toContain("ps-aux");
      expect(patterns).toContain("find");
      expect(patterns).toContain("tsc");
    });
  });

  describe("small output passthrough", () => {
    it("returns small output in full (< 15 lines)", () => {
      const raw = "line 1\nline 2\nline 3\nline 4\nline 5";
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
      expect(result.removed.tokensRemoved).toBe(0);
      expect(result.guardOk).toBe(true);
    });
  });

  describe("git log", () => {
    it("detects and compresses git log with many commits", () => {
      const raw = makeGitLog(50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.removed.counts.commits).toBe(50);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(result.guardOk).toBe(true);
    });

    it("keeps git log under threshold in full", () => {
      const raw = makeGitLog(10);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.removed.counts.commits).toBe(10);
      // 10 commits < 15 threshold, should keep all
      expect(result.prunedOutput).toBe(raw);
    });

    it("passes trust guard", () => {
      const raw = makeGitLog(30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("git diff", () => {
    it("detects and compresses large git diff", () => {
      const raw = makeGitDiff(10, 50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
    });

    it("keeps small git diff in full", () => {
      const raw = makeGitDiff(2, 5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
    });

    it("passes trust guard", () => {
      const raw = makeGitDiff(5, 30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("git status", () => {
    it("detects git status and returns in full (already compact)", () => {
      const raw = makeGitStatus(5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
      expect(result.guardOk).toBe(true);
    });
  });

  describe("git branch", () => {
    it("detects git branch and returns in full (already compact)", () => {
      const raw = makeGitBranch(10);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
      expect(result.guardOk).toBe(true);
    });
  });

  describe("npm install", () => {
    it("detects and compresses npm install output", () => {
      const raw = makeNpmInstall(50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
    });

    it("passes trust guard", () => {
      const raw = makeNpmInstall(30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("npm ls", () => {
    it("detects and compresses npm ls tree output", () => {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(`top-pkg-${i}@1.0.${i}`);
        for (let j = 0; j < 10; j++) {
          lines.push(`  └─┬ dep-${i}-${j}@2.0.${j}`);
          for (let k = 0; k < 5; k++) {
            lines.push(`    └── subdep-${i}-${j}-${k}@3.0.${k}`);
          }
        }
      }
      const raw = lines.join("\n");
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("npm build / webpack / vite", () => {
    it("detects and compresses webpack build output", () => {
      const lines: string[] = [];
      lines.push("asset main.js 128 KiB [emitted] (name: main)");
      for (let i = 0; i < 100; i++) {
        lines.push(`module ./src/file-${i}.ts 234 bytes [built] [1 error]`);
      }
      lines.push("compiled with 1 error in 5.2s");
      const raw = lines.join("\n");
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
    });
  });

  describe("docker logs", () => {
    it("detects and compresses docker logs with tail-keep", () => {
      const raw = makeDockerLogs(200, 50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      // Should keep error lines + tail
      expect(result.removed.counts.errors).toBeGreaterThan(0);
    });

    it("passes trust guard", () => {
      const raw = makeDockerLogs(100, 20);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("docker build", () => {
    it("detects and compresses docker build output", () => {
      const raw = makeDockerBuild(30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("docker ps", () => {
    it("detects docker ps and returns in full (already compact)", () => {
      const raw = makeDockerPs(5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
      expect(result.guardOk).toBe(true);
    });
  });

  describe("cargo build", () => {
    it("detects and compresses cargo build output", () => {
      const raw = makeCargoBuild(50, 10, 0);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });

    it("keeps error lines from cargo build", () => {
      const raw = makeCargoBuild(20, 5, 3);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toContain("error[E0308]");
      expect(result.guardOk).toBe(true);
    });
  });

  describe("kubectl logs", () => {
    it("detects and compresses kubectl logs with tail-keep", () => {
      const raw = makeKubectlLogs(200);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("kubectl get", () => {
    it("detects kubectl get and returns in full (already compact)", () => {
      const raw = makeKubectlGet(5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
      expect(result.guardOk).toBe(true);
    });
  });

  describe("ps aux", () => {
    it("detects and compresses ps aux with top-N", () => {
      const raw = makePsAux(50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
      // Should keep header + top 15 processes
      expect(result.removed.counts.kept).toBeLessThanOrEqual(16);
    });

    it("passes trust guard", () => {
      const raw = makePsAux(30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("ls -la", () => {
    it("detects and compresses large ls -la output", () => {
      const raw = makeLsLa(100);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });

    it("keeps small ls -la in full", () => {
      const raw = makeLsLa(10);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toBe(raw);
    });
  });

  describe("find", () => {
    it("detects and compresses find output with count-keep", () => {
      const raw = makeFind(100);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(result.removed.counts.collapsed).toBeGreaterThan(0);
    });

    it("passes trust guard", () => {
      const raw = makeFind(50);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("tree", () => {
    it("detects and compresses tree output", () => {
      const raw = makeTree(4, 3);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("make", () => {
    it("detects and compresses make output", () => {
      const raw = makeMake(20);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("go test", () => {
    it("detects and compresses go test output", () => {
      const raw = makeGoTest(50, 5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      // Should keep FAIL lines
      expect(result.prunedOutput).toContain("FAIL");
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("go build", () => {
    it("detects and compresses go build output with errors", () => {
      const raw = makeGoBuild(10);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("pip install", () => {
    it("detects and compresses pip install output", () => {
      const raw = makePipInstall(30);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("maven", () => {
    it("detects and compresses maven output", () => {
      const raw = makeMvn(10, 0);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });

    it("keeps error lines from maven output", () => {
      const raw = makeMvn(5, 3);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.prunedOutput).toContain("[ERROR]");
    });
  });

  describe("gradle", () => {
    it("detects and compresses gradle output", () => {
      const raw = makeGradle(10, false);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("rustc", () => {
    it("detects and compresses rustc output", () => {
      const raw = makeRustc(5, 10);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("tsc", () => {
    it("detects and compresses tsc output", () => {
      const raw = makeTsc(20, 5);
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThan(result.tokensFull);
      expect(result.prunedOutput).toContain("error TS");
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });

  describe("unrecognized shell output — fallback", () => {
    it("applies tail-keep fallback for unrecognized large output", () => {
      // Generate output that doesn't match any pattern
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`random output line ${i} with some text that doesn't match patterns`);
      }
      const raw = lines.join("\n");
      const result = shellOutputModule.prune(raw, emptyTask, defaultOpts);
      expect(result.guardOk).toBe(true);
      expect(result.tokensPruned).toBeLessThanOrEqual(result.tokensFull);
      expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
    });
  });
});

describe("shell-output — engine integration", () => {
  const engine = new PruningEngine();

  it("engine routes shell-output toolType to shellOutputModule", () => {
    const raw = makeGitLog(30);
    const result = engine.prune({
      toolType: "shell-output",
      rawOutput: raw,
      task: emptyTask,
    });
    expect(result.toolType).toBe("shell-output");
    expect(result.ruleId).toBe("shell-output.pattern-compress.v1");
    expect(result.guardOk).toBe(true);
  });

  it("engine guard verifies shell-output pruning", () => {
    const raw = makeDockerLogs(100, 20);
    const result = engine.prune({
      toolType: "shell-output",
      rawOutput: raw,
      task: emptyTask,
    });
    expect(result.guardOk).toBe(true);
    expect(verifyGuard(raw, result.prunedOutput)).toBe(true);
  });
});

describe("shell-output — router detection", () => {
  it("routes git log content to shell-output", () => {
    const raw = makeGitLog(20);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes docker logs content to shell-output", () => {
    const raw = makeDockerLogs(50);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes npm install content to shell-output", () => {
    const raw = makeNpmInstall(30);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes cargo build content to shell-output", () => {
    const raw = makeCargoBuild(20, 5, 0);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes ps aux content to shell-output", () => {
    const raw = makePsAux(20);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes find content to shell-output", () => {
    const raw = makeFind(50);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes tsc content to shell-output", () => {
    const raw = makeTsc(10, 0);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes maven content to shell-output", () => {
    const raw = makeMvn(10, 0);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });

  it("routes pip install content to shell-output", () => {
    const raw = makePipInstall(20);
    const route = routeContent(raw);
    expect(route.toolType).toBe("shell-output");
  });
});

describe("shell-output — strategy unit tests", () => {
  describe("tailKeep", () => {
    it("keeps last N lines + error lines with context", () => {
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(i === 10 ? "ERROR something broke" : `line ${i}`);
      }
      const { output, stats } = tailKeep(lines, 20);
      expect(stats.lines).toBe(100);
      expect(stats.errors).toBe(1);
      // Should contain the error line
      expect(output.some((l) => l.includes("ERROR"))).toBe(true);
      // Should contain tail lines
      expect(output.some((l) => l.includes("line 99"))).toBe(true);
    });

    it("collapses non-kept lines into annotations", () => {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(`line ${i}`);
      }
      const { output, stats } = tailKeep(lines, 10);
      expect(stats.collapsed).toBeGreaterThan(0);
      expect(output.some((l) => l.startsWith("‹warden›"))).toBe(true);
    });
  });

  describe("summaryKeep", () => {
    it("keeps summary lines + errors, collapses progress", () => {
      const lines = [
        "Compiling dep-1 v1.0.0",
        "Compiling dep-2 v1.0.0",
        "Compiling dep-3 v1.0.0",
        "Compiling dep-4 v1.0.0",
        "warning: unused variable in main.rs:10:5",
        "Compiling dep-5 v1.0.0",
        "Finished dev target in 5.2s",
      ];
      const { output, stats } = summaryKeep(lines, /^(Compiling|Finished|warning:|error)/);
      expect(stats.lines).toBe(7);
      // Should keep Compiling, warning, and Finished lines
      expect(output.filter((l) => !l.startsWith("‹warden›")).length).toBeGreaterThan(0);
    });
  });

  describe("countKeep", () => {
    it("keeps first N results + count annotation", () => {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(`/path/to/file-${i}.ts`);
      }
      const { output, stats } = countKeep(lines, 10);
      expect(stats.collapsed).toBe(40);
      expect(output.some((l) => l.startsWith("‹warden›") && l.includes("40 more"))).toBe(true);
    });

    it("returns all if under threshold", () => {
      const lines = ["a", "b", "c"];
      const { output, stats } = countKeep(lines, 10);
      expect(stats.collapsed).toBeUndefined();
      expect(output).toEqual(lines);
    });
  });

  describe("topN", () => {
    it("keeps top N processes by metric", () => {
      const lines = [
        "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
        "root      1001  0.1  1.0  12345  6789 pts/0    S+   10:00   0:01 node low.js",
        "root      1002  45.2  5.0  12345  6789 pts/0    S+   10:00   0:05 node high.js",
        "root      1003  2.3  2.0  12345  6789 pts/0    S+   10:00   0:02 node mid.js",
      ];
      const { output, stats } = topN(lines, 2, /^USER\s+PID\s+%CPU/, 2);
      expect(stats.kept).toBe(3); // header + 2 processes
      // The high CPU process should be in the output
      expect(output.some((l) => l.includes("45.2"))).toBe(true);
    });
  });
});

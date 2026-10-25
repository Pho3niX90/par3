#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone eval tooling; the driver runs in task containers without the monorepo's Effect runtime.
/**
 * Runs one Terminal-Bench task through a headless Par3 server in the task container and exports
 * per-turn usage for the lead and every delegated child: fresh T3CODE_HOME, `par3 serve`, create the
 * project, launch the thread, poll until all settle, write par3-export.json. Parts marked VERIFY are untested.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";

import {
  childThreadIds,
  isThreadSettled,
  slimProjection,
  type ExportedThread,
  type Par3TaskExport,
} from "../usage.ts";
import { ARMS, type Arm } from "./arms.ts";
import { Par3RpcClient } from "./rpc.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    arm: { type: "string" },
    "task-id": { type: "string", default: "unknown-task" },
    workspace: { type: "string", default: "/app" },
    "out-dir": { type: "string", default: "/logs/agent/par3" },
    "instruction-env": { type: "string", default: "PAR3_TASK_INSTRUCTION" },
    "instruction-file": { type: "string" },
    "par3-bin": { type: "string", default: process.env["PAR3_BIN"] ?? "par3" },
    "timeout-min": { type: "string", default: "120" },
    "poll-sec": { type: "string", default: "10" },
    // Paths (relative to the workspace) whose edits suggest the agent touched the grader.
    protect: {
      type: "string",
      default:
        "(^|/)(tests?|verifier)(/|$)|(^|/)test_[^/]*\\.py$|_test\\.(py|go|rs|ts|js)$|\\.test\\.[jt]sx?$|(^|/)conftest\\.py$|(^|/)run-tests\\.sh$",
    },
  },
});

function resolveArm(name: string | undefined): Arm {
  const arm = ARMS[name ?? ""];
  if (arm === undefined) throw new Error(`--arm must be one of ${Object.keys(ARMS).join(", ")}`);
  return arm;
}
const arm = resolveArm(values.arm);
const instruction =
  values["instruction-file"] !== undefined
    ? NodeFS.readFileSync(values["instruction-file"], "utf8")
    : process.env[values["instruction-env"]];
if (instruction === undefined || instruction.trim() === "") throw new Error("empty instruction");

const outDir = values["out-dir"];
const workspace = values.workspace;
NodeFS.mkdirSync(outDir, { recursive: true });

const SKIP_DIRS = new Set([".git", "node_modules", ".t3", ".venv", "__pycache__"]);

function hashProtectedFiles(root: string, pattern: RegExp): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (hashes.size > 20_000) return;
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        const rel = NodePath.relative(root, path).split("\\").join("/");
        if (pattern.test(rel)) {
          hashes.set(
            rel,
            NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
          );
        }
      }
    }
  };
  walk(root);
  return hashes;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(baseUrl: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await NodeTimersPromises.setTimeout(500);
    }
  }
  throw new Error(`server did not answer at ${baseUrl}`);
}

async function fetchThreadTree(
  client: Par3RpcClient,
  leadThreadId: string,
): Promise<ExportedThread[]> {
  const threads: ExportedThread[] = [];
  const queue = [leadThreadId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const threadId = queue.shift() as string;
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    const projection = await client.request("orchestration.getThreadProjection", { threadId });
    const thread = slimProjection(projection);
    threads.push(thread);
    queue.push(...childThreadIds(thread));
  }
  return threads;
}

async function main(): Promise<void> {
  const protectPattern = new RegExp(values.protect);
  const protectedBefore = hashProtectedFiles(workspace, protectPattern);
  // Never the developer's ~/.t3: every task gets its own throwaway home.
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "par3-home-"));
  const env = { ...process.env, T3CODE_HOME: home, T3CODE_NO_BROWSER: "1" };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = NodeFS.createWriteStream(NodePath.join(outDir, "server.log"));

  // VERIFY: `serve` accepts --port/--host/--base-dir and a positional cwd (apps/server/src/cli/config.ts).
  const server: NodeChildProcess.ChildProcess = NodeChildProcess.spawn(
    values["par3-bin"],
    ["serve", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port), workspace],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout?.pipe(serverLog);
  server.stderr?.pipe(serverLog);

  const startedAt = new Date();
  let leadThreadId = "";
  let threads: ExportedThread[] = [];
  let settled = false;
  let timedOut = false;
  let client: Par3RpcClient | undefined;
  try {
    await waitForHttp(baseUrl, Date.now() + 120_000);
    const token = NodeChildProcess.execFileSync(
      values["par3-bin"],
      ["auth", "session", "issue", "--base-dir", home, "--token-only", "--ttl", "1d"],
      { env, encoding: "utf8" },
    ).trim();
    client = await Par3RpcClient.connect(baseUrl, token);
    // Headless clients need fresh probes before selection validation; no composer
    // is open to refresh the providers while the benchmark runs.
    for (const instanceId of new Set([
      arm.lead.instanceId,
      ...(arm.sidekick ? [arm.sidekick.instanceId] : []),
    ])) {
      await client.request("server.refreshProviders", { instanceId, cwd: workspace, fresh: true });
    }

    const projectId = NodeCrypto.randomUUID();
    await client.request("projects.mutate", {
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: values["task-id"],
      workspaceRoot: workspace,
    });

    const launched = (await client.request("orchestration.launchThread", {
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: values["task-id"],
      modelSelection: arm.lead,
      sidekickModelSelection: arm.sidekick,
      // Terminal-Bench is unattended: nobody can answer an approval prompt.
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: instruction, attachments: [] },
    })) as { threadId: string };
    leadThreadId = launched.threadId;

    const deadline = Date.now() + Number(values["timeout-min"]) * 60_000;
    let settledPolls = 0;
    while (Date.now() < deadline) {
      await NodeTimersPromises.setTimeout(Number(values["poll-sec"]) * 1000);
      threads = await fetchThreadTree(client, leadThreadId);
      // A child's completion wakes the lead with a new run, so require two quiet polls.
      settledPolls = threads.every(isThreadSettled) ? settledPolls + 1 : 0;
      if (settledPolls >= 2) {
        settled = true;
        break;
      }
    }
    timedOut = !settled;
    if (timedOut) threads = await fetchThreadTree(client, leadThreadId);
  } finally {
    const finishedAt = new Date();
    const taskExport: Par3TaskExport = {
      schemaVersion: 1,
      taskId: values["task-id"],
      arm: values.arm ?? "",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      settled,
      timedOut,
      leadThreadId,
      threads,
      protectedFilesChanged: changedFiles(
        protectedBefore,
        hashProtectedFiles(workspace, protectPattern),
      ),
    };
    NodeFS.writeFileSync(
      NodePath.join(outDir, "par3-export.json"),
      `${JSON.stringify(taskExport, null, 2)}\n`,
    );
    client?.close();
    // Only the PID we spawned; never kill by name (AGENTS.md rule 1).
    server.kill("SIGTERM");
  }
}

await main();

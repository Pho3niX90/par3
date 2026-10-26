#!/usr/bin/env node
/**
 * A stand-in `claude` for the provider benchmark: replays recorded `claude -p` stdout with its delays
 * so every arm sees identical model time. Speaks stream-json for `-p` and the Agent SDK, answers control
 * requests, replays turn k on the k-th user message, and asks `can_use_tool` in approval modes.
 * Recording: T3_BENCH_STUB_RECORDING, one `{ "turn", "ms", "line" }` JSON object per line.
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("2.1.300 (Claude Code bench stub)\n");
  process.exit(0);
}

// Accepts `--name value` and `--name=value`; the SDK uses both.
const flag = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const sessionId = flag("--session-id") ?? flag("--resume");
const permissionMode = flag("--permission-mode") ?? "default";
const asksPermission =
  flag("--permission-prompt-tool") === "stdio" && permissionMode !== "bypassPermissions";
// Tools the CLI runs without asking in the default and acceptEdits modes.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "NotebookRead",
  "WebSearch",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const recordingPath = process.env.T3_BENCH_STUB_RECORDING;
if (!recordingPath) {
  process.stderr.write("T3_BENCH_STUB_RECORDING is not set\n");
  process.exit(2);
}
const turns = [];
for (const raw of NodeFS.readFileSync(recordingPath, "utf8").split("\n")) {
  if (raw.trim().length === 0) continue;
  const entry = JSON.parse(raw);
  const type = entry.line?.type;
  // Approval traffic is regenerated live; replaying the old one would be wrong.
  if (type === "control_request" || type === "control_response") continue;
  (turns[entry.turn] ??= []).push(entry);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

/** Uses the caller's session id so the adapter's native thread ref holds. */
function rewriteSession(value) {
  if (sessionId === undefined || typeof value !== "object" || value === null) return value;
  return "session_id" in value ? { ...value, session_id: sessionId } : value;
}

let nextRequest = 0;
const pendingPermissions = new Map();
function askPermission(block) {
  const requestId = `stub-${nextRequest++}`;
  const answered = new Promise((resolve) => pendingPermissions.set(requestId, resolve));
  write({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: block.name,
      input: block.input ?? {},
      tool_use_id: block.id,
    },
  });
  return answered;
}

function needsPermission(block) {
  if (!asksPermission || block?.type !== "tool_use") return false;
  if (READ_ONLY_TOOLS.has(block.name)) return false;
  return !(permissionMode === "acceptEdits" && EDIT_TOOLS.has(block.name));
}

let interrupted = false;
async function replayTurn(index) {
  const entries = turns[index] ?? [];
  const startedAt = performance.now();
  // Time spent waiting for approvals shifts the rest of the recording.
  let waited = 0;
  for (const entry of entries) {
    if (interrupted) break;
    await sleep(startedAt + waited + entry.ms - performance.now());
    const line = entry.line;
    if (line.type === "assistant" && line.parent_tool_use_id == null) {
      for (const block of line.message?.content ?? []) {
        if (!needsPermission(block)) continue;
        const asked = performance.now();
        await askPermission(block);
        waited += performance.now() - asked;
      }
    }
    write(rewriteSession(line));
  }
  if (interrupted) {
    interrupted = false;
    write(
      rewriteSession({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId ?? "",
      }),
    );
  }
}

function answerControl(message) {
  const request = message.request ?? {};
  const response = (() => {
    switch (request.subtype) {
      case "initialize":
        return {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models: [],
          account: {},
        };
      case "mcp_set_servers":
        return { added: [], removed: [], errors: {} };
      case "interrupt":
        interrupted = true;
        return {};
      default:
        return {};
    }
  })();
  write({
    type: "control_response",
    response: { subtype: "success", request_id: message.request_id, response },
  });
}

let turnIndex = 0;
let replaying = Promise.resolve();
const input = NodeReadline.createInterface({ input: process.stdin });
input.on("line", (raw) => {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === "control_request") return answerControl(message);
  if (message.type === "control_response") {
    pendingPermissions.get(message.response?.request_id)?.(message.response);
    pendingPermissions.delete(message.response?.request_id);
    return;
  }
  if (message.type === "user") {
    const index = turnIndex++;
    replaying = replaying.then(() => replayTurn(index));
  }
});
input.on("close", () => {
  void replaying.then(() => process.exit(0));
});

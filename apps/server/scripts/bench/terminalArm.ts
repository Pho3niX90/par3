// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - Host-side benchmark process driver.
/**
 * Arm T: interactive `claude` in a pseudo-terminal, as a user runs it. The
 * clock starts when Enter is written after the prompt; a `Stop` hook marks
 * the end of the turn, so nothing depends on scraping the screen. API time is
 * read back from the session transcript the CLI writes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { median } from "./benchStats.ts";
import { permissionModeFor, type ArmRunInput, type TurnSample } from "./benchTypes.ts";

const TURN_TIMEOUT_MS = 10 * 60_000;
const IDLE_MS = 1_500;

// The hook appends `<event> <epoch ms>`; it is plain JS so it needs no build.
const HOOK_SOURCE = `import { appendFileSync } from "node:fs";
const now = Date.now();
appendFileSync(process.argv[3], process.argv[2] + " " + now + "\\n");
`;

/**
 * How long `node` takes from spawn to running its first line, in epoch ms.
 * Subtracted from hook timestamps so the hook's own launch is not billed to
 * Claude.
 */
export function measureNodeSpawnMs(samples = 5): number {
  const measured = Array.from({ length: samples }, () => {
    const before = Date.now();
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(Date.now()))"],
      {
        encoding: "utf8",
      },
    );
    return Number(output) - before;
  });
  return median(measured);
}

/** The CLI's transcript for `sessionId`, under the config dir the CLI used. */
export function findTranscriptIn(
  configDirOverride: string | undefined,
  sessionId: string,
): string | undefined {
  const configDir =
    configDirOverride ??
    process.env.CLAUDE_CONFIG_DIR ??
    NodePath.join(NodeOS.homedir(), ".claude");
  const projects = NodePath.join(configDir, "projects");
  if (!NodeFS.existsSync(projects)) return undefined;
  for (const directory of NodeFS.readdirSync(projects)) {
    const candidate = NodePath.join(projects, directory, `${sessionId}.jsonl`);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * API time per prompt, summed over model requests: each assistant message's
 * last entry time minus the entry that preceded the request. The transcript
 * has no `duration_api_ms`, so this includes streaming, as the API time does.
 */
export function apiTimesFromTranscript(path: string): number[] {
  const entries = NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .flatMap((raw) => {
      try {
        return [JSON.parse(raw) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((entry) => typeof entry.timestamp === "string" && entry.isSidechain !== true);
  const turns: number[] = [];
  let requestStartedAt: number | undefined;
  let lastAssistant: { id: string; at: number } | undefined;
  const closeRequest = () => {
    if (lastAssistant !== undefined && requestStartedAt !== undefined && turns.length > 0) {
      turns[turns.length - 1]! += lastAssistant.at - requestStartedAt;
    }
    lastAssistant = undefined;
  };
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp as string);
    const message = entry.message as { id?: string; role?: string; content?: unknown } | undefined;
    if (entry.type === "user") {
      closeRequest();
      const content = message?.content;
      const isToolResult =
        Array.isArray(content) && content.some((block) => block?.type === "tool_result");
      if (!isToolResult && entry.isMeta !== true) turns.push(0);
      requestStartedAt = at;
    } else if (entry.type === "assistant" && typeof message?.id === "string") {
      if (lastAssistant !== undefined && lastAssistant.id !== message.id) {
        closeRequest();
        requestStartedAt = at;
      }
      lastAssistant = { id: message.id, at };
    }
  }
  closeRequest();
  return turns;
}

export async function runTerminalArm(
  input: ArmRunInput & {
    readonly claudeBin: string;
    readonly env: NodeJS.ProcessEnv;
    readonly nodeSpawnMs: number;
  },
): Promise<TurnSample[]> {
  const pty = await import("node-pty");
  const hookPath = NodePath.join(input.runDir, "bench-hook.mjs");
  const markerPath = NodePath.join(input.runDir, "hook-marks.txt");
  NodeFS.writeFileSync(hookPath, HOOK_SOURCE);
  NodeFS.writeFileSync(markerPath, "");
  const hookCommand = (event: string) =>
    `"${process.execPath.replaceAll("\\", "/")}" "${hookPath.replaceAll("\\", "/")}" ${event} "${markerPath.replaceAll("\\", "/")}"`;
  const settings = {
    skipDangerousModePermissionPrompt: true,
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: hookCommand("stop") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("submit") }] }],
    },
  };
  const sessionId = NodeCrypto.randomUUID();
  const permissionMode = permissionModeFor(input.runtimeMode);
  const args = [
    "--model",
    input.config.model,
    ...(input.config.effort === undefined ? [] : ["--effort", input.config.effort]),
    "--permission-mode",
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []),
    "--session-id",
    sessionId,
    "--settings",
    JSON.stringify(settings),
  ];
  const terminal = pty.spawn(input.claudeBin, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: input.cwd,
    env: input.env as Record<string, string>,
  });
  const screenPath = NodePath.join(input.runDir, "terminal.log");
  let recent = "";
  let lastOutputAt = performance.now();
  terminal.onData((data) => {
    lastOutputAt = performance.now();
    recent = (recent + data).slice(-16_384);
    NodeFS.appendFileSync(screenPath, data);
  });
  const exited = new Promise<void>((done) => terminal.onExit(() => done()));

  const plain = () => NodeUtil.stripVTControlCharacters(recent);
  const waitForIdle = async () => {
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      const screen = plain();
      // Start-up prompts are answered with their default ("Yes"), as a user would.
      if (/trust (the files in )?this folder/i.test(screen)) {
        recent = "";
        terminal.write("\r");
        continue;
      }
      if (/Bypass Permissions mode/i.test(screen) && /Yes, I accept/i.test(screen)) {
        recent = "";
        terminal.write("\x1b[B\r");
        continue;
      }
      if (performance.now() - lastOutputAt > IDLE_MS) return;
    }
    throw new Error("Claude terminal never went idle");
  };
  const marks = (event: string) =>
    NodeFS.readFileSync(markerPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith(`${event} `))
      .map((line) => Number(line.slice(event.length + 1)));

  const prompts = [
    input.workload.prompt,
    ...(input.workload.warmPrompt ? [input.workload.warmPrompt] : []),
  ];
  const turns: Array<{ wallMs: number }> = [];
  try {
    for (const [index, prompt] of prompts.entries()) {
      await waitForIdle();
      terminal.write(prompt);
      // Let the input box settle so Enter submits instead of joining a paste.
      await new Promise((done) => setTimeout(done, 300));
      const startedAt = Date.now();
      terminal.write("\r");
      const deadline = performance.now() + TURN_TIMEOUT_MS;
      while (marks("stop").length <= index) {
        if (performance.now() > deadline) throw new Error(`Turn ${index} timed out`);
        await new Promise((done) => setTimeout(done, 20));
      }
      if (marks("submit").length <= index) throw new Error("Prompt was not submitted");
      const stoppedAt = marks("stop")[index]! - input.nodeSpawnMs;
      turns.push({ wallMs: stoppedAt - startedAt });
    }
  } finally {
    terminal.kill();
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
  }

  const transcript = findTranscriptIn(input.config.claudeConfigDir, sessionId);
  const apiTimes = transcript === undefined ? [] : apiTimesFromTranscript(transcript);
  return turns.map((turn, index): TurnSample => {
    const apiMs = apiTimes[index];
    return {
      arm: "T",
      workload: input.workload.id,
      variant: input.variant,
      repetition: input.repetition,
      turn: index === 0 ? "cold" : "warm",
      wallMs: turn.wallMs,
      ...(apiMs === undefined ? {} : { apiMs, nonApiMs: turn.wallMs - apiMs }),
    };
  });
}

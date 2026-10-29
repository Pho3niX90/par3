import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## Par3 orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- To follow up a finished delegate in the same child, with its context, call \`delegate_task\` with \`continueTaskId\` set to its \`taskId\`. \`t3_thread_send\` on \`childThreadId\` only steers a child that is still running.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`t3_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a Par3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- Secrets already in the user's vault: \`vault_list\` shows names. Provider environment variables and shared MCP server headers accept \`vault:NAME\`. Call \`secret_get\` only when a value must appear in a command or file; never echo, commit, or pass it to another agent.
- For a service you have no native tool for (such as Linear or Sentry), call \`mcp_servers\` for the MCP servers Par3 shares, then \`mcp_call\`.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

/** What a lead needs to know about its sidekick; null when sidekick mode is off or inactive. */
export interface T3SidekickLeadState {
  /** Model and provider, e.g. "GPT-6 Luna · Codex". */
  readonly label: string;
  readonly billingModel: "per_token" | "per_request";
}

function sidekickStatesEqual(
  left: T3SidekickLeadState | null | undefined,
  right: T3SidekickLeadState | null | undefined,
): boolean {
  return (
    (left ?? null) === (right ?? null) ||
    (left != null &&
      right != null &&
      left.label === right.label &&
      left.billingModel === right.billingModel)
  );
}

/**
 * The lead playbook. Kept under 4,000 bytes so Codex delivers it whole as one
 * instruction entry.
 */
export function sidekickInstructions(state: T3SidekickLeadState): string {
  return `## Par3 sidekick mode

This thread has a sidekick: ${state.label}. You are the lead. You plan, brief, review and decide; the sidekick explores, implements and tests. Each of you keeps its own context, so you exchange only briefs and reports. The user's explicit instructions always override this playbook, and it does not apply in plan mode.

1. Delegate exploration, multi-file edits, and build/test/lint loops with \`delegate_task\`, leaving \`target\` unset so it runs on the sidekick. Write spec-quality briefs: goal, constraints, relevant files, success criteria, and the report you need back. Small, surgical edits are fine to make yourself when the exact lines are already in your context and no test loop is needed.
2. Keep planning, ambiguity and final review yourself. Review the sidekick's work with \`git diff\`. Commit yourself, unless the user said otherwise.
3. Use \`mode:"async"\` and end your turn; the sidekick's completion wakes you. Use \`mode:"wait"\` only for short checks this turn needs.
4. Follow up, don't re-delegate: for related work, call \`delegate_task\` with \`continueTaskId\` on the same task once its result has arrived. Use a fresh \`delegate_task\` for unrelated work.
5. While a shared-checkout sidekick task is unfinished, do not edit files or run git commands that change state. Parallel tasks that write files must use \`isolation:"worktree"\`; parallel tasks in the shared checkout must be read-only. A worktree task reports its workspace: inspect it, then apply or integrate the changes before committing.
6. When the sidekick reports \`Status: blocked\` or fails twice, take over. If its task is still running, call \`task_cancel\` and wait for it to settle before you edit.
7. Answer the sidekick's pending questions with the \`t3_pending_request_*\` tools. Approvals and anything that needs the user go to the user. On a usage limit, take over or tell the user; do not retry in a loop.
8. For an independent review, set \`target\` explicitly (for example your own model from \`orchestrator_capabilities\`); an omitted target goes to the sidekick.
9. Do not use your native subagent or task tool for sidekick work: it would go untracked and may run on the wrong model.
10. The user can type into the sidekick's thread, so expect results you did not request; they wake you too.${
    state.billingModel === "per_request"
      ? "\n11. The sidekick is billed per request: batch work into fewer, larger briefs."
      : ""
  }`;
}

export const SIDEKICK_OFF_INSTRUCTIONS = `## Par3 sidekick mode is now off

This thread no longer has a sidekick. Ignore the earlier sidekick playbook: \`delegate_task\` without a target now runs on your own model, and you choose again when to delegate.`;

/**
 * What a provider must send after the sidekick state it last sent. Undefined
 * `previous` means a fresh native context that has seen nothing yet.
 */
export function sidekickInstructionUpdate(
  previous: T3SidekickLeadState | null | undefined,
  next: T3SidekickLeadState | null,
): string | null {
  if (previous !== undefined && sidekickStatesEqual(previous, next)) return null;
  if (next !== null) return sidekickInstructions(next);
  return previous == null ? null : SIDEKICK_OFF_INSTRUCTIONS;
}

/** Prepended to a brief that runs on the thread's sidekick. Instructions, not a permission boundary. */
export const SIDEKICK_CHILD_PREAMBLE = `You are the sidekick on this task: a lead agent wrote this brief and will review your work.
- Stay in the brief's scope. If the brief is wrong or unsafe, say so in your report instead of working around it.
- Do not commit, and do not delegate the work further.
- End every turn with a report in this shape:
  Status: done | blocked | needs_decision
  Changed: what you changed, by file
  Commands: what you ran and the result
  Open issues: anything left or uncertain
  Workspace: the checkout path, when you work in a separate worktree`;

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Par3 browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## Par3 devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Par3 interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Par3 supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## Par3 interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. You can embed screenshots in proposed plans using Markdown images with absolute file paths. Treat this mode as active until Par3 supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly sidekick?: T3SidekickLeadState | null;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  // The playbook drives T3 tools, so it only counts while they are available.
  const sidekickOf = (state: T3AcpInstructionState) =>
    state.hasT3Mcp ? (state.sidekick ?? null) : null;
  const sidekickUpdate = sidekickInstructionUpdate(
    input.previousState === undefined ? undefined : sidekickOf(input.previousState),
    sidekickOf(input.state),
  );
  const baseUnchanged =
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools;
  if (baseUnchanged && sidekickUpdate === null) return input.prompt;
  const instructions = [
    ...(baseUnchanged
      ? []
      : [
          input.state.interactionMode === "plan"
            ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
            : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
          ...(input.state.hasT3Mcp
            ? [
                T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
                ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
                T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
                T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
              ]
            : []),
        ]),
    ...(sidekickUpdate === null ? [] : [sidekickUpdate]),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

/** What a provider without a system prompt field last sent into one native session. */
export interface T3PromptInstructionState {
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly sidekick: T3SidekickLeadState | null;
}

/**
 * For providers whose only channel is the user prompt: the wrapped block to send, or null when the
 * native session has it. Orchestration goes on each native session's first prompt (or once T3 tools
 * appear), device instructions once device tools appear, the sidekick playbook whenever it
 * changes. Undefined `previousState` is a fresh context.
 */
export function t3OrchestrationInstructionUpdate(
  state: T3PromptInstructionState,
  previousState: T3PromptInstructionState | undefined,
): string | null {
  // The playbook drives T3 tools, so it only counts while they are available.
  const sidekickOf = (value: T3PromptInstructionState) => (value.hasT3Mcp ? value.sidekick : null);
  const sidekickUpdate = sidekickInstructionUpdate(
    previousState === undefined ? undefined : sidekickOf(previousState),
    sidekickOf(state),
  );
  const hadDeviceTools = previousState?.hasT3Mcp === true && previousState.hasDeviceTools;
  const instructions = [
    ...(state.hasT3Mcp && previousState?.hasT3Mcp !== true
      ? [T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
    ...(state.hasT3Mcp && state.hasDeviceTools && !hadDeviceTools
      ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS.trim()]
      : []),
    ...(sidekickUpdate === null ? [] : [sidekickUpdate]),
  ];
  if (instructions.length === 0) return null;
  // The explicit wrapper keeps T3 context from reading as text the user wrote.
  return `<t3_code_orchestration_instructions>\n${instructions.join("\n\n")}\n</t3_code_orchestration_instructions>`;
}

/**
 * Prepends `t3OrchestrationInstructionUpdate` to a user prompt. Callers record
 * `state` only when the returned text differs from `prompt`.
 */
export function t3PromptWithOrchestrationInstructions(input: {
  readonly prompt: string;
  readonly state: T3PromptInstructionState;
  readonly previousState: T3PromptInstructionState | undefined;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const update = t3OrchestrationInstructionUpdate(input.state, input.previousState);
  return update === null
    ? input.prompt
    : `${update}\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}

import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationSystemPrompt,
  t3PromptWithOrchestrationInstructions,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Use `delegate_task` for another provider's model",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "make new top-level threads");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never mean one");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Every new delegate review or re-check is a new `delegate_task`",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "with `continueTaskId`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "`t3_thread_send` on `childThreadId` only steers a child that is still running",
    );
  });

  it("points agents at the user's vault and shared MCP servers", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`vault:NAME`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `mcp_servers`");
  });

  it("injects prompt fallback on a fresh MCP-enabled native session only", () => {
    const prompt = "Inspect the repository.";
    const withMcp = { hasT3Mcp: true, hasDeviceTools: false, sidekick: null } as const;
    const injected = t3PromptWithOrchestrationInstructions({
      prompt,
      state: withMcp,
      previousState: undefined,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, "Par3 orchestration");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3PromptWithOrchestrationInstructions({ prompt, state: withMcp, previousState: withMcp }),
      prompt,
    );
    assert.equal(
      t3PromptWithOrchestrationInstructions({
        prompt,
        state: { hasT3Mcp: false, hasDeviceTools: false, sidekick: null },
        previousState: undefined,
      }),
      prompt,
    );
    assert.equal(
      t3PromptWithOrchestrationInstructions({
        prompt: "/compress",
        state: withMcp,
        previousState: undefined,
      }),
      "/compress",
    );
  });

  it("sends prompt-fallback sidekick updates without repeating orchestration", () => {
    const prompt = "Continue.";
    const sidekick = { label: "Luna · Codex", billingModel: "per_token" } as const;
    const on = { hasT3Mcp: true, hasDeviceTools: false, sidekick } as const;
    const off = { hasT3Mcp: true, hasDeviceTools: false, sidekick: null } as const;

    const enabled = t3PromptWithOrchestrationInstructions({
      prompt,
      state: on,
      previousState: off,
    });
    assert.include(enabled, "This thread has a sidekick: Luna · Codex.");
    assert.notInclude(enabled, "Par3 orchestration");
    const disabled = t3PromptWithOrchestrationInstructions({
      prompt,
      state: off,
      previousState: on,
    });
    assert.include(disabled, "Par3 sidekick mode is now off");
    const fresh = t3PromptWithOrchestrationInstructions({
      prompt,
      state: on,
      previousState: undefined,
    });
    assert.include(fresh, "Par3 orchestration");
    assert.include(fresh, "This thread has a sidekick: Luna · Codex.");
    assert.equal(
      t3PromptWithOrchestrationInstructions({
        prompt,
        state: { hasT3Mcp: false, hasDeviceTools: false, sidekick },
        previousState: undefined,
      }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false, false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true, false), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false },
    });

    assert.include(injected, "Par3 interaction mode: Default");
    assert.include(injected, "## Par3 browser");
    assert.include(injected, "Par3 orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
    } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Par3 interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false },
    });
    assert.include(withoutMcp, "Par3 interaction mode: Default");
    assert.notInclude(withoutMcp, "Par3 collaborative browser");
    assert.notInclude(withoutMcp, "Par3 orchestration");
  });
});

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## Par3 devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const state = (hasDeviceTools: boolean) =>
      ({ hasT3Mcp: true, hasDeviceTools, sidekick: null }) as const;
    const prompt = "Check the login screen.";
    const firstRun = (hasDeviceTools: boolean) =>
      t3PromptWithOrchestrationInstructions({
        prompt,
        state: state(hasDeviceTools),
        previousState: undefined,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Par3 devices");

    const devicesAppeared = t3PromptWithOrchestrationInstructions({
      prompt,
      state: state(true),
      previousState: state(false),
    });
    assert.include(devicesAppeared, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(devicesAppeared, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(
      t3PromptWithOrchestrationInstructions({
        prompt,
        state: state(true),
        previousState: state(true),
      }),
      prompt,
    );
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## Par3 devices");
  });
});

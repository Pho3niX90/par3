import { assert, describe, it } from "@effect/vitest";

import {
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
    const withMcp = { hasT3Mcp: true, sidekick: null } as const;
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
        state: { hasT3Mcp: false, sidekick: null },
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
    const on = { hasT3Mcp: true, sidekick } as const;
    const off = { hasT3Mcp: true, sidekick: null } as const;

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
        state: { hasT3Mcp: false, sidekick },
        previousState: undefined,
      }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "Par3 interaction mode: Default");
    assert.include(injected, "## Par3 browser");
    assert.include(injected, "Par3 orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

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
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "Par3 interaction mode: Default");
    assert.notInclude(withoutMcp, "Par3 collaborative browser");
    assert.notInclude(withoutMcp, "Par3 orchestration");
  });
});

import { assert, it } from "@effect/vitest";

import {
  SIDEKICK_OFF_INSTRUCTIONS,
  sidekickInstructionUpdate,
  sidekickInstructions,
  t3AcpPromptWithInstructions,
} from "./orchestrationInstructions.ts";

const luna = { label: "GPT-6 Luna · Codex", billingModel: "per_token" } as const;
const copilot = { label: "Opus 5.5 · Copilot", billingModel: "per_request" } as const;

it("sends the playbook on enable, change and a fresh context, and the off text on disable", () => {
  assert.equal(sidekickInstructionUpdate(undefined, null), null);
  assert.equal(sidekickInstructionUpdate(undefined, luna), sidekickInstructions(luna));
  assert.equal(sidekickInstructionUpdate(null, luna), sidekickInstructions(luna));
  assert.equal(sidekickInstructionUpdate(luna, { ...luna }), null);
  assert.equal(sidekickInstructionUpdate(luna, copilot), sidekickInstructions(copilot));
  assert.equal(sidekickInstructionUpdate(luna, null), SIDEKICK_OFF_INSTRUCTIONS);
  assert.equal(sidekickInstructionUpdate(null, null), null);
});

it("tells a per-request sidekick's lead to batch, and fits one Codex instruction entry", () => {
  assert.include(sidekickInstructions(copilot), "billed per request");
  assert.notInclude(sidekickInstructions(luna), "billed per request");
  assert.isBelow(new TextEncoder().encode(sidekickInstructions(copilot)).length, 4_000);
});

it("adds only the sidekick change to an ACP prompt whose other instructions were sent", () => {
  const base = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
  const prompt = t3AcpPromptWithInstructions({
    prompt: "Next step",
    previousState: { ...base, sidekick: null },
    state: { ...base, sidekick: luna },
  });
  assert.include(prompt, "## Par3 sidekick mode");
  assert.notInclude(prompt, "## Par3 orchestration");
  assert.equal(
    t3AcpPromptWithInstructions({
      prompt: "Next step",
      previousState: { ...base, sidekick: luna },
      state: { ...base, sidekick: luna },
    }),
    "Next step",
  );
  // Without T3 tools the playbook cannot be followed, so it is not sent.
  assert.notInclude(
    t3AcpPromptWithInstructions({
      prompt: "Next step",
      state: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false, sidekick: luna },
    }),
    "sidekick mode",
  );
});

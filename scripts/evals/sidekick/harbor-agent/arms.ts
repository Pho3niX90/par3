import type { WireModelSelection } from "../usage.ts";

/**
 * Option ids are the ones the providers advertise (claudeModelOptions / Codex catalog):
 * Claude `effort`, Codex `reasoningEffort`. Instance ids are the default built-in instances.
 */
const OPUS_MAX: WireModelSelection = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "max" }],
};

const LUNA_HIGH: WireModelSelection = {
  instanceId: "codex",
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "high" }],
};

export interface Arm {
  readonly lead: WireModelSelection;
  readonly sidekick: WireModelSelection | null;
}

export const ARMS: Readonly<Record<string, Arm>> = {
  A: { lead: OPUS_MAX, sidekick: null },
  B: { lead: OPUS_MAX, sidekick: LUNA_HIGH },
};

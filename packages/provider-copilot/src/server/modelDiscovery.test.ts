import { describe, expect, it } from "@effect/vitest";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { copilotModelsFromSessionSetup } from "./modelDiscovery.ts";

type SessionSetupResult = AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];

const modelOption = (options: ReadonlyArray<unknown>): SessionSetupResult =>
  ({
    configOptions: [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.4",
        options,
      },
    ],
  }) as unknown as SessionSetupResult;

describe("copilotModelsFromSessionSetup", () => {
  it("lists the models of a model config option", () => {
    const models = copilotModelsFromSessionSetup(
      modelOption([
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
      ]),
    );
    expect(models).toEqual([
      { slug: "gpt-5.4", name: "GPT-5.4" },
      { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    ]);
  });

  it("flattens grouped options", () => {
    const models = copilotModelsFromSessionSetup(
      modelOption([
        {
          group: "openai",
          name: "OpenAI",
          options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
        },
        { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
      ]),
    );
    expect(models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-haiku-4.5"]);
  });

  it("falls back to session model state when there is no model option", () => {
    const models = copilotModelsFromSessionSetup({
      models: {
        currentModelId: "gpt-5.4",
        availableModels: [
          { modelId: "gpt-5.4", name: "GPT-5.4" },
          { modelId: "claude-haiku-4.5", name: " " },
        ],
      },
    });
    expect(models).toEqual([
      { slug: "gpt-5.4", name: "GPT-5.4" },
      { slug: "claude-haiku-4.5", name: "claude-haiku-4.5" },
    ]);
  });

  it("prefers the model option over session model state", () => {
    const models = copilotModelsFromSessionSetup({
      ...modelOption([{ value: "from-option", name: "From option" }]),
      models: {
        currentModelId: "from-state",
        availableModels: [{ modelId: "from-state", name: "From state" }],
      },
    });
    expect(models.map((model) => model.slug)).toEqual(["from-option"]);
  });

  it("falls back to session model state when the model option has no choices", () => {
    const models = copilotModelsFromSessionSetup({
      ...modelOption([]),
      models: {
        currentModelId: "from-state",
        availableModels: [{ modelId: "from-state", name: "From state" }],
      },
    });
    expect(models.map((model) => model.slug)).toEqual(["from-state"]);
  });

  it("never lists the product default sentinel, blanks, or duplicates", () => {
    const models = copilotModelsFromSessionSetup(
      modelOption([
        { value: "default", name: "Default" },
        { value: "  ", name: "Blank" },
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "gpt-5.4", name: "GPT-5.4 again" },
      ]),
    );
    expect(models).toEqual([{ slug: "gpt-5.4", name: "GPT-5.4" }]);
  });

  it("returns nothing when the session advertises no models", () => {
    expect(copilotModelsFromSessionSetup({})).toEqual([]);
    expect(copilotModelsFromSessionSetup({ configOptions: [] })).toEqual([]);
  });
});

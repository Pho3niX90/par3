/**
 * Reads the models a live GitHub Copilot ACP session advertises: first its `model` config option,
 * then its session model state. Copilot documents no session-less catalog, and health checks must
 * not open sessions, so models are learned only from sessions that start for real.
 */
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { COPILOT_DEFAULT_MODEL_SLUG } from "./acpSupport.ts";

const MAX_ADVERTISED_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_MODEL_NAME_LENGTH = 160;

export interface CopilotAdvertisedModel {
  readonly slug: string;
  readonly name: string;
}

type SessionSetupResult = AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];

export function copilotModelsFromSessionSetup(
  setup: Pick<SessionSetupResult, "configOptions" | "models">,
): ReadonlyArray<CopilotAdvertisedModel> {
  const modelOption = setup.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const modelOptionCandidates =
    modelOption?.type === "select"
      ? modelOption.options
          .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
          .map((entry) => ({ id: entry.value, name: entry.name }))
      : [];
  const candidates =
    modelOptionCandidates.length > 0
      ? modelOptionCandidates
      : (setup.models?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
        }));

  const seen = new Set<string>([COPILOT_DEFAULT_MODEL_SLUG]);
  const models: Array<CopilotAdvertisedModel> = [];
  for (const candidate of candidates) {
    const slug = candidate.id.trim();
    if (slug.length === 0 || slug.length > MAX_MODEL_ID_LENGTH || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: candidate.name.trim().slice(0, MAX_MODEL_NAME_LENGTH) || slug,
    });
    if (models.length === MAX_ADVERTISED_MODELS) break;
  }
  return models;
}

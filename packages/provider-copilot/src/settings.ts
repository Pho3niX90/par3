/**
 * GitHub Copilot instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-copilot/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CopilotSettings = makeProviderSettingsSchema(
  {
    // On by default in this fork: the provider is probed at startup, and once the CLI is found
    // working it leads the provider order (see providerStatusCache.ts).
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("copilot").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the GitHub Copilot CLI binary.",
        providerSettingsForm: { placeholder: "copilot", clearWhenEmpty: "omit" },
      }),
    ),
    enterpriseUrl: Schema.optional(Schema.String).pipe(
      Schema.annotateKey({
        title: "Enterprise URI / Host",
        description:
          "The URI or hostname for your GHE.com or GitHub Enterprise Server instance (e.g. https://company.ghe.com or https://github.octocat.com). Leave empty for standard GitHub.com.",
        providerSettingsForm: { placeholder: "https://company.ghe.com", clearWhenEmpty: "omit" },
      }),
    ),
    enterpriseToken: Schema.optional(Schema.String).pipe(
      Schema.annotateKey({
        title: "Access token",
        description:
          "Stored in plain text on disk. A fine-grained personal access token with the Copilot Requests permission; classic (ghp_) tokens are not supported. Leave empty to use your Copilot CLI login.",
        providerSettingsForm: {
          control: "password",
          placeholder: "github_pat_...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "enterpriseUrl", "enterpriseToken"],
  },
);

export type CopilotSettings = typeof CopilotSettings.Type;

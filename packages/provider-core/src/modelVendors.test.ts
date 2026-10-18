import { ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { defineProviderClient, modelVendorIcon } from "./client.ts";
import { MODEL_VENDOR_ICONS, modelVendorForSlug } from "./modelVendors.ts";

const settingsSchema = Schema.Struct({ binaryPath: Schema.String });

describe("modelVendorForSlug", () => {
  it("reads the vendor from Copilot model slugs", () => {
    expect(modelVendorForSlug("claude-opus-5.5")).toBe("anthropic");
    expect(modelVendorForSlug("claude-haiku-4.5")).toBe("anthropic");
    expect(modelVendorForSlug("gpt-6.1-sol")).toBe("openai");
    expect(modelVendorForSlug("gpt-5.3-codex")).toBe("openai");
    expect(modelVendorForSlug("o4-mini")).toBe("openai");
    expect(modelVendorForSlug("o3")).toBe("openai");
    expect(modelVendorForSlug("chatgpt-4o-latest")).toBe("openai");
    expect(modelVendorForSlug("codex-mini-latest")).toBe("openai");
    expect(modelVendorForSlug("gemini-3.8-flash")).toBe("google");
    expect(modelVendorForSlug("grok-4.7")).toBe("xai");
    expect(modelVendorForSlug("mai-code-1.1-flash")).toBe("microsoft");
  });

  it("leaves routing aliases and unknown vendors without a vendor", () => {
    expect(modelVendorForSlug("auto")).toBeNull();
    expect(modelVendorForSlug("default")).toBeNull();
    expect(modelVendorForSlug("ollama-llama-4")).toBeNull();
    expect(modelVendorForSlug("opus")).toBeNull();
    expect(modelVendorForSlug("codexray-1")).toBeNull();
    expect(modelVendorForSlug("o1x")).toBeNull();
  });
});

describe("modelVendorIcon", () => {
  const base = { label: "Test", settingsSchema } as const;
  const aggregator = defineProviderClient({
    ...base,
    driverKind: ProviderDriverKind.make("copilot"),
    modelVendorIcons: true,
  });
  const singleVendor = defineProviderClient({
    ...base,
    driverKind: ProviderDriverKind.make("claudeAgent"),
  });

  it("draws vendor glyphs only for drivers that opt in", () => {
    expect(modelVendorIcon(aggregator, "claude-opus-5.5")).toBe(MODEL_VENDOR_ICONS.anthropic);
    expect(modelVendorIcon(singleVendor, "claude-opus-5.5")).toBeUndefined();
    expect(modelVendorIcon(undefined, "claude-opus-5.5")).toBeUndefined();
  });

  it("falls back to the driver glyph when the model has no vendor", () => {
    expect(modelVendorIcon(aggregator, "auto")).toBeUndefined();
    expect(modelVendorIcon(aggregator, undefined)).toBeUndefined();
  });
});

import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.paritylabs.par3"],
  ["development", "com.paritylabs.par3.dev"],
  ["preview", "com.paritylabs.par3.preview"],
  ["production", "com.paritylabs.par3"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
});

// expo-observe's Android module throws in OnCreate without one, which stops the app starting.
it.each(["development", "preview", "production"])(
  "gives Observe the GUID project id the relay requires, with updates off, for APP_VARIANT=%j",
  async (variant) => {
    const config = await loadConfig(variant);
    expect(config.extra?.eas?.projectId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(config.updates?.enabled).toBe(false);
  },
);

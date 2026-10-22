import { describe, expect, it } from "vite-plus/test";

import { vaultSecretNameError } from "./vaultSettings.logic";

describe("vaultSecretNameError", () => {
  it("accepts an environment-variable style name", () => {
    expect(vaultSecretNameError(" OPENAI_API_KEY ", [])).toBeNull();
  });

  it("explains names the vault refuses", () => {
    expect(vaultSecretNameError("1KEY", [])).toMatch(/not starting with a digit/);
    expect(vaultSecretNameError("API-KEY", [])).toMatch(/letters, digits/);
    expect(vaultSecretNameError("TOKEN", ["TOKEN"])).toBe("TOKEN is already in the vault.");
  });
});

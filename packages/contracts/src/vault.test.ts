import { describe, expect, it } from "vite-plus/test";

import { AuthAccessWriteScope, AuthProvidersManageScope, AuthSettingsWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import { parseVaultReference, vaultReference } from "./vault.ts";

describe("vault references", () => {
  it("recognizes only a whole `vault:NAME` value", () => {
    expect(parseVaultReference(vaultReference("API_TOKEN"))).toBe("API_TOKEN");
    expect(parseVaultReference(" vault:API_TOKEN ")).toBe("API_TOKEN");
    expect(parseVaultReference("vault:")).toBeNull();
    expect(parseVaultReference("vault:1BAD")).toBeNull();
    expect(parseVaultReference("Bearer vault:API_TOKEN")).toBeNull();
    expect(parseVaultReference("plain-secret")).toBeNull();
  });
});

describe("vault and sync permissions", () => {
  it("asks for owner access only for mutations that hand out or drop the vault key", () => {
    const scopes = (input: unknown) => clientRpcRequiredScopes(WS_METHODS.vaultMutate, input);
    expect(scopes({ _tag: "set", name: "API_TOKEN", value: "v" })).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(scopes({ _tag: "setAgentReadable", name: "API_TOKEN", agentReadable: true })).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(scopes({ _tag: "create" })).toEqual([AuthAccessWriteScope]);
    expect(scopes({ _tag: "leave" })).toEqual([AuthAccessWriteScope]);
    expect(clientRpcRequiredScopes(WS_METHODS.vaultWrapKeyFor, undefined)).toEqual([
      AuthAccessWriteScope,
    ]);
  });

  it("treats writing synced items as provider administration", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.syncApply, { ops: [] })).toEqual([
      AuthProvidersManageScope,
    ]);
  });
});

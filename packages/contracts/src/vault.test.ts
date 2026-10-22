import { describe, expect, it } from "vite-plus/test";

import { AuthAccessWriteScope, AuthProvidersManageScope, AuthSettingsWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import { syncItemKey } from "./sync.ts";
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

  it("treats writing synced files as provider administration", () => {
    const op = (key: string) => ({
      key,
      expectedHash: null,
      action: { _tag: "delete" },
      baseline: { hash: null, rev: 1 },
    });
    expect(clientRpcRequiredScopes(WS_METHODS.syncApply, { ops: [] })).toEqual([
      AuthProvidersManageScope,
    ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.syncApply, {
        ops: [op(syncItemKey("claude.agents", "agents/a.md"))],
      }),
    ).toEqual([AuthProvidersManageScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.syncSetParticipation, {
        enabled: true,
        categories: ["claude.agents"],
        excluded: [],
      }),
    ).toEqual([AuthProvidersManageScope]);
  });

  it("also asks for settings access when a sync touches settings or the vault", () => {
    const both = [AuthProvidersManageScope, AuthSettingsWriteScope];
    for (const key of [syncItemKey("vault", "API_TOKEN"), syncItemKey("mcpServers", "linear")]) {
      expect(
        clientRpcRequiredScopes(WS_METHODS.syncApply, {
          ops: [
            {
              key: syncItemKey("claude.agents", "agents/a.md"),
              expectedHash: null,
              action: { _tag: "delete" },
              baseline: { hash: null, rev: 1 },
            },
            {
              key,
              expectedHash: null,
              action: { _tag: "delete" },
              baseline: { hash: null, rev: 1 },
            },
          ],
        }),
      ).toEqual(both);
    }
    expect(
      clientRpcRequiredScopes(WS_METHODS.syncSetParticipation, {
        enabled: true,
        categories: ["claude.agents", "vault"],
        excluded: [],
      }),
    ).toEqual(both);
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionEnvironmentDescriptor,
  repositoryCloneRemoteUrl,
  repositoryGroupingKeyOf,
  workspaceRepositoryIdentity,
} from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [
      { kind: "npx" },
      { kind: "npm-global", prefix: "/opt/node" },
      { kind: "npm-global", prefix: "/opt/node", packageName: "par3-cli" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [
      { kind: "future-manager" },
      { kind: "npm-global" },
      { kind: "npm-global", prefix: "/opt/node", packageName: "par3-cli; rm -rf ~" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});

describe("workspaceRepositoryIdentity", () => {
  const member = (path: string, key: string, displayName?: string) => ({
    path,
    canonicalKey: key,
    remoteUrl: `https://${key}.git`,
    ...(displayName ? { displayName } : {}),
  });

  it("keys on the sorted, unique member keys regardless of paths and order", () => {
    const identity = workspaceRepositoryIdentity({
      rootPath: "/work/acme",
      members: [
        member("web", "github.com/acme/web"),
        member("api", "github.com/acme/api"),
        member("web-2", "github.com/acme/web"),
      ],
    });
    expect(identity.canonicalKey).toBe("workspace:github.com/acme/api|github.com/acme/web");
    expect(repositoryGroupingKeyOf(identity)).toBe(identity.canonicalKey);
    expect(identity.locator.remoteUrl).toBe(identity.canonicalKey);
    expect(identity.members?.map((entry) => entry.path)).toEqual(["api", "web", "web-2"]);
    expect(identity.provider).toBeUndefined();
  });

  it.each([
    [["Acme/web", "Acme/api"], "Acme/api + Acme/web"],
    [["a", "b", "c", "d", "e"], "a + b + c +2 more"],
  ])("names %j as %s", (names, expected) => {
    const identity = workspaceRepositoryIdentity({
      rootPath: "/work/acme",
      members: names.map((name) => member(name, `github.com/${name}`, name)),
    });
    expect(identity.displayName).toBe(expected);
  });

  it("falls back to the key's last segment for a member without a name", () => {
    const identity = workspaceRepositoryIdentity({
      rootPath: "/work/acme",
      members: [member("web", "github.com/acme/web")],
    });
    expect(identity.displayName).toBe("web");
  });
});

describe("repositoryCloneRemoteUrl", () => {
  const locator = {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@host:a/b.git",
  } as const;

  it("prefers the fork's own remote, and offers nothing for a workspace", () => {
    expect(repositoryCloneRemoteUrl({ canonicalKey: "host/a/b", locator })).toBe(locator.remoteUrl);
    expect(
      repositoryCloneRemoteUrl({
        canonicalKey: "host/a/b",
        locator,
        origin: { canonicalKey: "host/me/b", remoteUrl: "git@host:me/b.git" },
      }),
    ).toBe("git@host:me/b.git");
    expect(
      repositoryCloneRemoteUrl(
        workspaceRepositoryIdentity({
          rootPath: "/work/acme",
          members: [{ path: "b", canonicalKey: "host/a/b", remoteUrl: locator.remoteUrl }],
        }),
      ),
    ).toBeNull();
  });
});

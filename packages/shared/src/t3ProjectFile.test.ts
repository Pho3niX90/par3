import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseT3ProjectFile, T3ProjectFileFromJson } from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("reads the repositories a folder lists", () => {
    const repositories = [
      { path: "frontend", url: "git@github.com:acme/frontend.git" },
      { path: "services/api", url: "https://github.com/acme/api.git" },
      { path: "..hidden/a.b", url: "https://github.com/acme/hidden.git" },
    ];
    expect(parseT3ProjectFile(JSON.stringify({ repositories }))).toEqual({ repositories });
  });

  it.each([
    "",
    "/etc",
    "\\\\host\\share",
    "C:\\repo",
    "C:repo",
    ".",
    "..",
    "../up",
    "a/../../up",
    "a/./b",
    "a//b",
    "a/",
    " .. ",
  ])("rejects the repository path %j", (path) => {
    expect(
      parseT3ProjectFile(JSON.stringify({ repositories: [{ path, url: "git@host:a/b.git" }] })),
    ).toBeNull();
  });
});

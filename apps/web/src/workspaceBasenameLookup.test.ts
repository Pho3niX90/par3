import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  workspaceFileLookup,
} from "@t3tools/client-runtime/workspace-basename-lookup";

describe("workspaceFileLookup", () => {
  const cwd = "C:\\Projects\\jvn-group-products";
  const entries = [
    { path: "bikeconnectors/legal/BC-04-motorcycle-rental-agreement.md", kind: "file" as const },
    { path: "bikeconnectors/legal", kind: "directory" as const },
    { path: "bikeconnectors/website/lib/site.ts", kind: "file" as const },
    { path: "jvn-food-group/website/lib/site.ts", kind: "file" as const },
  ];

  // An agent that `cd`ed into a subfolder names files relative to its shell, not the project.
  it("finds a path written relative to a subfolder", () => {
    const lookup = workspaceFileLookup("legal/BC-04-motorcycle-rental-agreement.md", cwd);
    expect(lookup?.pick(entries)).toBe("bikeconnectors/legal/BC-04-motorcycle-rental-agreement.md");
  });

  it("matches whole path segments, ignoring case on Windows", () => {
    expect(
      workspaceFileLookup("Legal/bc-04-motorcycle-rental-agreement.md", cwd)?.pick(entries),
    ).toBe("bikeconnectors/legal/BC-04-motorcycle-rental-agreement.md");
    expect(
      workspaceFileLookup("gal/BC-04-motorcycle-rental-agreement.md", cwd)?.pick(entries),
    ).toBeNull();
    expect(
      workspaceFileLookup("legal/bc-04-motorcycle-rental-agreement.md", "/srv/jvn")?.pick(entries),
    ).toBeNull();
  });

  it("refuses to guess between subfolders", () => {
    expect(workspaceFileLookup("website/lib/site.ts", cwd)?.pick(entries)).toBeNull();
  });

  it("does not look up paths that step outside the written location", () => {
    expect(workspaceFileLookup("../legal/BC-04-motorcycle-rental-agreement.md", cwd)).toBeNull();
    expect(workspaceFileLookup("./legal/BC-04-motorcycle-rental-agreement.md", cwd)).toBeNull();
    expect(workspaceFileLookup("C:\\Projects\\legal\\BC-04.md", cwd)).toBeNull();
  });

  it("strips a repeated project folder before matching", () => {
    expect(
      workspaceFileLookup("jvn-group-products/bikeconnectors/website/lib/site.ts", cwd)?.pick(
        entries,
      ),
    ).toBe("bikeconnectors/website/lib/site.ts");
  });
});

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  // regression: #6297 a bare filename resolves to a file, never a same-named directory
  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { isValidSpecSlug, parseSpecSlugOrNull, slugifySpecTitle } from "./state";

describe("spec slugs", () => {
  it("slugifies free titles the same way in both layouts", () => {
    for (const layout of ["par3", "base"] as const) {
      expect(slugifySpecTitle("  Dark Mode: v2!  ", layout)).toBe("dark-mode-v2");
      expect(parseSpecSlugOrNull("Dark Mode", layout)).toBe("dark-mode");
    }
  });

  it("keeps a typed BASE folder name intact only in a BASE checkout", () => {
    expect(slugifySpecTitle("PROJ-123_short-kebab", "base")).toBe("PROJ-123_short-kebab");
    expect(parseSpecSlugOrNull("PROJ-123_short-kebab", "base")).toBe("PROJ-123_short-kebab");
    expect(isValidSpecSlug("PROJ-123_short-kebab", "base")).toBe(true);
    expect(isValidSpecSlug("2026-short-kebab", "base")).toBe(true);

    expect(slugifySpecTitle("PROJ-123_short-kebab")).toBe("proj-123-short-kebab");
    expect(isValidSpecSlug("PROJ-123_short-kebab")).toBe(false);
    expect(isValidSpecSlug("Upper", "base")).toBe(false);
    expect(parseSpecSlugOrNull("PROJ-123 short kebab", "base")).toBe("proj-123-short-kebab");
  });
});

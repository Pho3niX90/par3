import { describe, expect, it } from "vite-plus/test";

import {
  describeSkillAvailability,
  describeSkillSource,
  filterProviderSkills,
} from "./ProviderSkillsSection.logic";

describe("describeSkillSource", () => {
  it("prefers the discovery source and falls back to the scope", () => {
    expect(describeSkillSource({ source: "add-dir", scope: "project" })).toBe("Added directory");
    expect(describeSkillSource({ scope: "user" })).toBe("User");
    expect(describeSkillSource({ source: "marketplace" })).toBe("marketplace");
    expect(describeSkillSource({})).toBeNull();
  });
});

describe("describeSkillAvailability", () => {
  it("explains skills the composer will not offer", () => {
    expect(describeSkillAvailability({ enabled: false })).toMatch(/disabled/i);
    expect(describeSkillAvailability({ enabled: true, userInvocable: false })).toMatch(
      /agent only/i,
    );
    expect(describeSkillAvailability({ enabled: true })).toBeNull();
  });
});

describe("filterProviderSkills", () => {
  const skills = [
    { name: "plugin:review", source: "plugin" },
    { name: "deploy", source: "project" },
  ];

  it("matches on name or source label", () => {
    expect(filterProviderSkills(skills, "REV").map((s) => s.name)).toEqual(["plugin:review"]);
    expect(filterProviderSkills(skills, "project").map((s) => s.name)).toEqual(["deploy"]);
    expect(filterProviderSkills(skills, " ")).toHaveLength(2);
  });
});

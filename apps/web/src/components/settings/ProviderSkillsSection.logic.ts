import type { ServerProviderSkill } from "@t3tools/contracts";

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  user: "User",
  project: "Project",
  "add-dir": "Added directory",
  plugin: "Plugin",
};

/**
 * Providers that don't tag a source yet still report a scope, so fall back to
 * it rather than showing nothing.
 */
export function describeSkillSource(
  skill: Pick<ServerProviderSkill, "source" | "scope">,
): string | null {
  const raw = skill.source ?? skill.scope;
  if (raw === undefined) return null;
  return SOURCE_LABELS[raw] ?? raw;
}

/** Why the composer won't offer this skill under `$` or `/`, when it won't. */
export function describeSkillAvailability(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): string | null {
  if (!skill.enabled) return "Disabled in provider settings";
  if (skill.userInvocable === false) return "Agent only (not offered in the composer)";
  return null;
}

export function filterProviderSkills<
  T extends Pick<ServerProviderSkill, "name" | "displayName" | "source" | "scope">,
>(skills: ReadonlyArray<T>, query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...skills];
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(normalized) ||
      (skill.displayName?.toLowerCase().includes(normalized) ?? false) ||
      (describeSkillSource(skill)?.toLowerCase().includes(normalized) ?? false),
  );
}

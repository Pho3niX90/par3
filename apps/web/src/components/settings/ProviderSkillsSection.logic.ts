import type { ServerProviderSkill } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  user: msg("User", { $context: "where a skill comes from" }),
  project: msg("Project", { $context: "where a skill comes from" }),
  "add-dir": msg("Added directory"),
  plugin: msg("Plugin", { $context: "where a skill comes from" }),
  managed: msg("Managed", { $context: "where a skill comes from" }),
};

/**
 * Providers that don't tag a source yet still report a scope, so fall back to
 * it rather than showing nothing.
 */
export function describeSkillSource(
  skill: Pick<ServerProviderSkill, "source" | "scope">,
  resolve: MessageResolver = m,
): string | null {
  const raw = skill.source ?? skill.scope;
  if (raw === undefined) return null;
  const label = SOURCE_LABELS[raw];
  return label === undefined ? raw : resolve(label);
}

/** Why the composer won't offer this skill under `$` or `/`, when it won't. */
export function describeSkillAvailability(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
  resolve: MessageResolver = m,
): string | null {
  if (!skill.enabled) return resolve(msg("Disabled in provider settings"));
  if (skill.userInvocable === false) {
    return resolve(msg("Agent only (not offered in the composer)"));
  }
  return null;
}

export function filterProviderSkills<
  T extends Pick<ServerProviderSkill, "name" | "displayName" | "source" | "scope">,
>(skills: ReadonlyArray<T>, query: string, resolve: MessageResolver = m): T[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...skills];
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(normalized) ||
      (skill.displayName?.toLowerCase().includes(normalized) ?? false) ||
      (describeSkillSource(skill, resolve)?.toLowerCase().includes(normalized) ?? false),
  );
}

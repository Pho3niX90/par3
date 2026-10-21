import type { ServerProvider } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import {
  describeSkillAvailability,
  describeSkillSource,
  filterProviderSkills,
} from "./ProviderSkillsSection.logic";

const FILTER_THRESHOLD = 8;
// Plugin-heavy setups can report hundreds of skills; rendering them all just to scroll past is waste.
const MAX_RENDERED_ROWS = 200;

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What the provider reported when Par3 last probed it. Per-project skills (a
 * project's own `.claude/skills`, say) appear in that project's composer, not here.
 */
export function ProviderSkillsSection({
  instanceId,
  provider,
}: {
  readonly instanceId: string;
  readonly provider: Pick<ServerProvider, "skills" | "slashCommands">;
}) {
  const [filter, setFilter] = useState("");
  const { skills, slashCommands } = provider;
  if (skills.length === 0 && slashCommands.length === 0) return null;

  const normalizedFilter = filter.trim().toLowerCase();
  const matchingSkills = filterProviderSkills(skills, filter);
  const matchingCommands =
    normalizedFilter.length === 0
      ? slashCommands
      : slashCommands.filter((command) => command.name.toLowerCase().includes(normalizedFilter));
  const visibleSkills = matchingSkills.slice(0, MAX_RENDERED_ROWS);
  const visibleCommands = matchingCommands.slice(0, MAX_RENDERED_ROWS);
  const truncated =
    matchingSkills.length > visibleSkills.length ||
    matchingCommands.length > visibleCommands.length;

  return (
    <FoldedSettingsSection
      id={`provider-instance-${instanceId}-skills`}
      title="Skills and commands"
      summary={`${pluralize(skills.length, "skill")} · ${pluralize(slashCommands.length, "command")}`}
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {skills.length + slashCommands.length > FILTER_THRESHOLD ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or source"
            size="sm"
            className="w-56 max-w-full"
            spellCheck={false}
            aria-label="Filter skills and commands"
          />
        ) : null}
        <div className="max-h-64 space-y-4 overflow-y-auto">
          {visibleSkills.length > 0 ? (
            <ul className="space-y-1" aria-label="Skills">
              {visibleSkills.map((skill) => {
                const source = describeSkillSource(skill);
                const availability = describeSkillAvailability(skill);
                return (
                  <li
                    key={`${skill.name}:${skill.path}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate font-mono">${skill.name}</span>
                    {source ? (
                      <Badge variant="outline" size="sm">
                        {source}
                      </Badge>
                    ) : null}
                    {availability ? (
                      <span className="shrink-0 text-muted-foreground">{availability}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {visibleCommands.length > 0 ? (
            <ul className="space-y-1" aria-label="Commands">
              {visibleCommands.map((command) => (
                <li key={command.name} className="text-xs">
                  <span className="font-mono">/{command.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {matchingSkills.length === 0 && matchingCommands.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing matches.</p>
          ) : null}
          {truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {MAX_RENDERED_ROWS}. Filter to narrow the list.
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          A skill missing from the composer is usually not listed here: check that its plugin is
          enabled, or that the project or added directory holds it.
        </p>
      </div>
    </FoldedSettingsSection>
  );
}

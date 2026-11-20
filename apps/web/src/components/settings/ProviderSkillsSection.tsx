import type { ServerProvider } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
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
  const gt = useGT();
  const m = useMessages();
  const [filter, setFilter] = useState("");
  const { skills, slashCommands } = provider;
  if (skills.length === 0 && slashCommands.length === 0) return null;

  const normalizedFilter = filter.trim().toLowerCase();
  const matchingSkills = filterProviderSkills(skills, filter, m);
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
      title={gt("Skills and commands")}
      summary={gt(
        "{skillCount, plural, one {{skillCount} skill} other {{skillCount} skills}} · {commandCount, plural, one {{commandCount} command} other {{commandCount} commands}}",
        { skillCount: skills.length, commandCount: slashCommands.length },
      )}
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {skills.length + slashCommands.length > FILTER_THRESHOLD ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={gt("Filter by name or source")}
            size="sm"
            className="w-56 max-w-full"
            spellCheck={false}
            aria-label={gt("Filter skills and commands")}
          />
        ) : null}
        <div className="max-h-64 space-y-4 overflow-y-auto">
          {visibleSkills.length > 0 ? (
            <ul className="space-y-1" aria-label={gt("Skills")}>
              {visibleSkills.map((skill) => {
                const source = describeSkillSource(skill, m);
                const availability = describeSkillAvailability(skill, m);
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
            <ul className="space-y-1" aria-label={gt("Commands")}>
              {visibleCommands.map((command) => (
                <li key={command.name} className="text-xs">
                  <span className="font-mono">/{command.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {matchingSkills.length === 0 && matchingCommands.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>Nothing matches.</T>
            </p>
          ) : null}
          {truncated ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Showing the first <Var>{MAX_RENDERED_ROWS}</Var>. Filter to narrow the list.
              </T>
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <T>
            A skill missing from the composer is usually not listed here: check that its plugin is
            enabled, or that the project or added directory holds it.
          </T>
        </p>
      </div>
    </FoldedSettingsSection>
  );
}

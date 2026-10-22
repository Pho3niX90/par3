import remarkParse from "remark-parse";
import { unified } from "unified";

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export function splitProposedPlanSections(markdown: string) {
  const sections: { id: string; level: number; title: string; markdown: string }[] = [];
  const occurrences = new Map<string, number>();
  const lines = markdown.split(/\r?\n/);
  const boundaries = unified()
    .use(remarkParse)
    .parse(markdown)
    .children.filter(
      (node) =>
        node.type === "heading" &&
        node.depth <= 3 &&
        /^ {0,3}#{1,3}(?:[ \t]|$)/.test(lines[(node.position?.start.line ?? 1) - 1] ?? ""),
    );
  let start = 0;
  const append = (end: number, level: number, title: string) => {
    if (end <= start) return;
    const slug =
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "") || "section";
    const occurrence = (occurrences.get(slug) ?? 0) + 1;
    occurrences.set(slug, occurrence);
    sections.push({
      id: `${slug}-${occurrence}`,
      level,
      title,
      markdown: lines.slice(start, end).join("\n"),
    });
    start = end;
  };
  let level = 0;
  let title = "Plan";
  for (const node of boundaries) {
    const line = (node.position?.start.line ?? 1) - 1;
    append(line, level, title);
    level = node.type === "heading" ? node.depth : 0;
    title =
      (lines[line] ?? "")
        .replace(/^ {0,3}#{1,3}[ \t]*/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim() || "Untitled section";
  }
  append(lines.length, level, title);
  return sections;
}

export function proposedPlanOutline(markdown: string) {
  return splitProposedPlanSections(markdown)
    .filter((section) => section.level > 0)
    .map(({ id, level, title }) => ({ id, level, title }));
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

export function proposedPlanReferenceDefinitions(markdown: string) {
  return unified()
    .use(remarkParse)
    .parse(markdown)
    .children.filter((node) => node.type === "definition")
    .map((node) => markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0))
    .join("\n");
}

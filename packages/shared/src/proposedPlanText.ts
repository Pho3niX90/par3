import remarkParse from "remark-parse";
import { unified } from "unified";

function headingText(line: string): string | null {
  const heading = line.match(/^ {0,3}#{1,6}([ \t].*)?$/);
  if (!heading) return null;
  const text = heading[1] ?? "";
  return text.replace(/[ \t]#+[ \t]*$/, "").trim();
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  let fence = "";
  let comment = false;
  for (const line of planMarkdown.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const [, marker = "", info = ""] = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/) ?? [];
    if (fence) {
      if (marker[0] === fence[0] && marker.length >= fence.length && /^[ \t]*$/.test(info)) {
        fence = "";
      }
      continue;
    }
    if (comment || /^ {0,3}<!--/.test(line)) {
      comment = !line.includes("-->");
      continue;
    }
    // CommonMark: a backtick fence's info string cannot contain a backtick.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) {
      fence = marker;
      continue;
    }
    const heading = headingText(line);
    if (heading) return heading;
  }
  return null;
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
  const lines = planMarkdown
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/);
  let start = 0;
  while (lines[start]?.trim().length === 0 || headingText(lines[start] ?? "") === "") {
    start += 1;
  }
  if (headingText(lines[start] ?? "")) start += 1;
  while (lines[start]?.trim().length === 0) {
    start += 1;
  }
  if (headingText(lines[start] ?? "")?.toLowerCase() === "summary") {
    start += 1;
    while (lines[start]?.trim().length === 0) {
      start += 1;
    }
  }
  return lines.slice(start).join("\n");
}

export function proposedPlanReferenceDefinitions(markdown: string) {
  return unified()
    .use(remarkParse)
    .parse(markdown)
    .children.filter((node) => node.type === "definition")
    .map((node) => markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0))
    .join("\n");
}

import {
  type SpecDocument,
  type SpecEvidence,
  type SpecFinding,
  type SpecRole,
  type SpecStatus,
  type SpecTask,
} from "@t3tools/contracts";

import { withoutFrontmatter } from "./specFrontmatter.ts";

// A list marker may carry a task-list checkbox. Ticking it does not retire a criterion; only ~~AC-n~~ does.
const LIST_MARKER = String.raw`(?:[-*]\s+(?:\[[ xX]\][ \t]+)?)?`;

export function acceptanceCriteria(content: string) {
  return [
    ...content.matchAll(
      new RegExp(String.raw`^\s*${LIST_MARKER}(~~)?(AC-[1-9]\d*)\b([^\n]*)`, "gm"),
    ),
  ].map((match) => ({
    id: match[2]!,
    retired: match[1] === "~~",
    text: match[3]!.replace(/^\s*[:.—-]\s*/, "").trim(),
  }));
}

const PAR3_HEADINGS = [
  "Summary",
  "Scope",
  "Users and scenarios",
  "Acceptance criteria",
  "Constraints",
  "Open questions",
  "Design notes",
] as const;

/**
 * `par3` matches headings loosely, at levels 1 to 3, and a section ends at any next heading.
 * `base` matches level-2 headings exactly, ignores fenced code, and keeps `###` inside its parent.
 */
export interface ReadinessRules {
  readonly mode: "par3" | "base";
  readonly headings: readonly string[];
}

export const PAR3_READINESS: ReadinessRules = { mode: "par3", headings: PAR3_HEADINGS };

/** Without a template a BASE spec has no required sections, only acceptance criteria. */
export const baseReadiness = (template: string | null): ReadinessRules => ({
  mode: "base",
  headings: template === null ? [] : templateHeadings(template),
});

interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { char: string; length: number } | undefined;
  let offset = 0;
  for (const raw of content.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
    } else if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else {
      const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
      if (heading)
        headings.push({
          level: heading[1]!.length,
          text: heading[2]!,
          start: offset,
          end: offset + raw.length,
        });
    }
    offset += raw.length + 1;
  }
  return headings;
}

/** Every `## Heading` in a BASE template, in order, outside fenced code. */
export function templateHeadings(template: string): string[] {
  const names = markdownHeadings(template)
    .filter((heading) => heading.level === 2 && heading.text !== "")
    .map((heading) => heading.text);
  return [...new Set(names)];
}

const normalizeHeading = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function baseSectionBody(
  content: string,
  headings: readonly MarkdownHeading[],
  name: string,
): string | undefined {
  const index = headings.findIndex(
    (heading) => heading.level === 2 && normalizeHeading(heading.text) === normalizeHeading(name),
  );
  if (index === -1) return undefined;
  const next = headings.slice(index + 1).find((heading) => heading.level <= 2);
  return content.slice(headings[index]!.end, next?.start);
}

// The `[blocking]` marker may follow a list marker and a task-list checkbox.
const BLOCKING_QUESTION = new RegExp(String.raw`^\s*${LIST_MARKER}\[blocking\]`, "im");
// BASE only lets a spec into review once no high-impact question is open; a ticked box is resolved.
const OPEN_HIGH_QUESTION = /^[ \t]*[-*][ \t]+\[ \][^\n]*\[high\]/im;

export function checkReady(content: string, rules: ReadinessRules = PAR3_READINESS): SpecFinding[] {
  const findings: SpecFinding[] = [];
  const base = rules.mode === "base";
  const baseContent = base ? withoutFrontmatter(content) : content;
  const baseHeadings = base ? markdownHeadings(baseContent) : [];
  for (const heading of rules.headings) {
    if (base) {
      const body = baseSectionBody(baseContent, baseHeadings, heading);
      if (body === undefined)
        findings.push({ code: "missing-section", message: `Add the ${heading} section.` });
      else if (!body.trim())
        findings.push({ code: "empty-section", message: `Complete the ${heading} section.` });
      continue;
    }
    const sections = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)];
    const section = sections.find((item) => item[1]!.toLowerCase().includes(heading.toLowerCase()));
    if (!section)
      findings.push({ code: "missing-section", message: `Add the ${heading} section.` });
    else {
      const start = section.index + section[0].length;
      const next = sections.find((item) => item.index > section.index);
      if (!content.slice(start, next?.index).trim())
        findings.push({ code: "empty-section", message: `Complete the ${heading} section.` });
    }
  }
  const criteria = acceptanceCriteria(content);
  const active = criteria.filter((item) => !item.retired);
  if (!active.length)
    findings.push({
      code: "missing-criteria",
      message: "Add at least one active AC-n acceptance criterion.",
    });
  const seen = new Set<string>();
  for (const item of criteria) {
    if (seen.has(item.id))
      findings.push({
        code: "duplicate-criterion",
        criterion: item.id,
        message: `${item.id} appears more than once.`,
      });
    seen.add(item.id);
    if (!item.retired && !item.text)
      findings.push({
        code: "empty-criterion",
        criterion: item.id,
        message: `${item.id} needs a testable statement.`,
      });
  }
  const questions = base
    ? rules.headings
        .filter((heading) => heading.toLowerCase().includes("open questions"))
        .map((heading) => baseSectionBody(baseContent, baseHeadings, heading) ?? "")
        .join("\n")
    : content;
  if (BLOCKING_QUESTION.test(questions) || (base && OPEN_HIGH_QUESTION.test(questions)))
    findings.push({
      code: "blocking-question",
      message: base
        ? "Resolve open [HIGH] and [blocking] questions before requesting review."
        : "Resolve questions marked [blocking] before requesting review.",
    });
  return findings;
}

export function checkCriterionHistory(previous: string, next: string): string | undefined {
  const old = acceptanceCriteria(previous);
  const incoming = acceptanceCriteria(next);
  for (const item of old) {
    const replacement = incoming.find((candidate) => candidate.id === item.id);
    if (!replacement)
      return `Retain ${item.id}; retire it with ~~${item.id}~~ instead of deleting or renumbering it.`;
    if (item.retired && !replacement.retired) return `${item.id} was retired and cannot be reused.`;
  }
  const highest = Math.max(0, ...old.map((item) => Number(item.id.slice(3))));
  if (
    incoming.some(
      (item) =>
        !old.some((candidate) => candidate.id === item.id) && Number(item.id.slice(3)) <= highest,
    )
  )
    return "New acceptance criteria must use IDs greater than every previously allocated ID.";
}

export function checkTasks(content: string, tasks: readonly SpecTask[]): string | undefined {
  const active = new Set(
    acceptanceCriteria(content)
      .filter((item) => !item.retired)
      .map((item) => item.id),
  );
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) return "Task IDs must be unique.";
  for (const task of tasks) {
    if (!task.acs.length || task.acs.some((id) => !active.has(id)))
      return `Task ${task.id} must reference active acceptance criteria.`;
    if (task.dependsOn.some((id) => id === task.id || !ids.has(id)))
      return `Task ${task.id} has an invalid dependency.`;
    if (!task.verify.trim()) return `Task ${task.id} needs a verification step.`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (tasks.find((task) => task.id === id)?.dependsOn.some(cycle)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (tasks.some((task) => cycle(task.id))) return "Task dependencies must not contain cycles.";
  for (const id of active)
    if (!tasks.some((task) => task.acs.includes(id))) return `Add task coverage for ${id}.`;
}

export function taskDefinitions(tasks: readonly SpecTask[]) {
  return tasks.map(({ id, title, acs, dependsOn, verify }) => ({
    id,
    title,
    acs,
    dependsOn,
    verify,
  }));
}

export function evidenceComplete(
  document: Pick<SpecDocument, "content" | "specHash" | "taskHash" | "evidence">,
): boolean {
  const active = acceptanceCriteria(document.content).filter((item) => !item.retired);
  return (
    active.length > 0 &&
    active.every((criterion) =>
      document.evidence.some(
        (item: SpecEvidence) =>
          item.acs.includes(criterion.id) &&
          item.passed &&
          item.checkpoint.trim() &&
          item.requirementsHash === document.specHash &&
          item.taskHash === document.taskHash &&
          (item.kind !== "manual" || Boolean(item.confirmedBy)),
      ),
    )
  );
}

export function transitionAllowed(from: SpecStatus, to: SpecStatus, role: SpecRole | "human") {
  if (role === "human")
    return (
      (from === "review" && ["approved", "rejected", "draft"].includes(to)) ||
      (["rejected", "done", "implemented", "blocked"].includes(from) &&
        ["draft", "review", "in-progress"].includes(to))
    );
  if (role === "requirements") return from === "draft" && to === "review";
  if (role === "implementation")
    return (
      ((from === "approved" || from === "blocked") && to === "in-progress") ||
      (from === "in-progress" && (to === "blocked" || to === "implemented"))
    );
  if (role === "test") return from === "implemented" && (to === "done" || to === "in-progress");
  return false;
}

/** What still blocks a spec from entering a status that implies finished work, or undefined. */
export function lifecycleProblem(
  document: Pick<SpecDocument, "content" | "tasks" | "specHash" | "taskHash" | "evidence">,
  status: SpecStatus,
): string | undefined {
  if (["in-progress", "implemented", "done"].includes(status)) {
    const problem = checkTasks(document.content, document.tasks);
    if (problem) return problem;
  }
  if (
    ["implemented", "done"].includes(status) &&
    document.tasks.some((task) => task.status !== "passed")
  )
    return "Every task must pass its verification first.";
  if (status === "done" && !evidenceComplete(document))
    return "Every active criterion needs current passing evidence, with human confirmation for manual checks.";
}

/**
 * Whether a status read from a BASE spec's frontmatter can be adopted without a human decision.
 * `approved` never is: approval is Par3's own record and only a person grants it.
 */
export function statusAdoptable(
  document: Pick<
    SpecDocument,
    | "status"
    | "approvalValid"
    | "approval"
    | "findings"
    | "content"
    | "tasks"
    | "specHash"
    | "taskHash"
    | "evidence"
  >,
  next: SpecStatus,
): boolean {
  if (next === document.status || next === "approved") return false;
  if (
    !(["human", "requirements", "implementation", "test"] as const).some((role) =>
      transitionAllowed(document.status, next, role),
    )
  )
    return false;
  if (next === "review") return document.findings.length === 0;
  if (["in-progress", "implemented", "done"].includes(next))
    return (
      document.approvalValid && document.approval !== null && !lifecycleProblem(document, next)
    );
  return true;
}

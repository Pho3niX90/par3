import {
  type SpecDocument,
  type SpecEvidence,
  type SpecFinding,
  type SpecRole,
  type SpecStatus,
  type SpecTask,
} from "@t3tools/contracts";

export function acceptanceCriteria(content: string) {
  return [...content.matchAll(/^\s*(?:[-*]\s+)?(~~)?(AC-[1-9]\d*)\b([^\n]*)/gm)].map((match) => ({
    id: match[2]!,
    retired: match[1] === "~~",
    text: match[3]!.replace(/^\s*[:.—-]\s*/, "").trim(),
  }));
}

export function checkReady(content: string): SpecFinding[] {
  const findings: SpecFinding[] = [];
  for (const heading of [
    "Summary",
    "Scope",
    "Users and scenarios",
    "Acceptance criteria",
    "Constraints",
    "Open questions",
    "Design notes",
  ]) {
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
  if (/^\s*(?:[-*]\s+)?\[blocking\]/im.test(content))
    findings.push({
      code: "blocking-question",
      message: "Resolve questions marked [blocking] before requesting review.",
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

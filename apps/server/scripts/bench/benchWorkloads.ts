// @effect-diagnostics nodeBuiltinImport:off - Host-side benchmark fixture builder.
/**
 * Benchmark workloads and the fixture repository they run against. The repo is
 * generated from code, so every run and every arm starts from identical files.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type WorkloadId = "W1" | "W2" | "W3" | "W4" | "W5";

export interface Workload {
  readonly id: WorkloadId;
  readonly title: string;
  /** Prompt for the first (cold) turn. */
  readonly prompt: string;
  /** Prompt for a second turn in the same session, when the workload reports warm turns. */
  readonly warmPrompt?: string;
  readonly repeats: number;
}

const PARALLEL_READ_FILES = [
  "src/text/slugify.ts",
  "src/text/truncate.ts",
  "src/money/formatCurrency.ts",
  "src/money/parseAmount.ts",
  "src/dates/addDays.ts",
  "src/dates/isWeekend.ts",
  "src/collections/chunk.ts",
  "src/collections/groupBy.ts",
];

export const WORKLOADS: ReadonlyArray<Workload> = [
  {
    id: "W1",
    title: "W1 trivial reply",
    prompt: "Reply with exactly: ok",
    warmPrompt: "Reply with exactly: ok again",
    repeats: 10,
  },
  {
    id: "W2",
    title: "W2 read-heavy search",
    prompt:
      "Without editing anything, find every function under src/ that calls formatCurrency. Use your search and read tools to confirm each call site, then list them as `file: function` lines.",
    repeats: 6,
  },
  {
    id: "W3",
    title: "W3 edit and test",
    prompt:
      "The test in test/slugify.test.ts fails because slugify in src/text/slugify.ts does not collapse repeated hyphens. Fix slugify, then run `node --test test/slugify.test.ts` and report whether it passes.",
    repeats: 6,
  },
  {
    id: "W4",
    title: "W4 long answer with thinking",
    prompt:
      "Think it through, then explain in about 500 words when optimistic locking beats pessimistic locking in a relational database, with one concrete example of each. Do not use any tools.",
    warmPrompt:
      "Now explain in about 300 words how you would detect lost updates in the optimistic case. Do not use any tools.",
    repeats: 10,
  },
  {
    id: "W5",
    title: "W5 parallel reads",
    prompt: `Read these 8 files in parallel, in a single batch of tool calls, then give a one-line summary of each: ${PARALLEL_READ_FILES.join(", ")}. Do not read any other files.`,
    repeats: 10,
  },
];

export function selectWorkloads(ids: ReadonlyArray<string> | undefined): ReadonlyArray<Workload> {
  if (ids === undefined || ids.length === 0) return WORKLOADS;
  return ids.map((id) => {
    const workload = WORKLOADS.find((candidate) => candidate.id === id);
    if (workload === undefined) throw new Error(`Unknown workload ${id}`);
    return workload;
  });
}

function moduleSource(name: string, body: string, doc: string): string {
  return `/** ${doc} */\nexport function ${name}${body}\n`;
}

/** Relative path to file contents. About 30 files, a test that fails until W3 is done. */
function fixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "bench-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test test/slugify.test.ts" },
      },
      null,
      2,
    ),
    "README.md":
      "# Bench fixture\n\nSmall utility library used by the Par3 provider benchmark. Run `node --test test/slugify.test.ts`.\n",
    "tsconfig.json": JSON.stringify(
      { compilerOptions: { target: "es2022", module: "nodenext", strict: true, noEmit: true } },
      null,
      2,
    ),
    "src/text/slugify.ts": moduleSource(
      "slugify",
      `(input: string): string {\n  return input\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, (match) => "-".repeat(match.length))\n    .replace(/^-|-$/g, "");\n}`,
      "Turns a title into a URL slug.",
    ),
    "src/text/truncate.ts": moduleSource(
      "truncate",
      `(input: string, max: number): string {\n  return input.length <= max ? input : \`\${input.slice(0, Math.max(0, max - 1))}…\`;\n}`,
      "Shortens text to at most `max` characters.",
    ),
    "src/text/capitalize.ts": moduleSource(
      "capitalize",
      `(input: string): string {\n  return input.charAt(0).toUpperCase() + input.slice(1);\n}`,
      "Upper-cases the first character.",
    ),
    "src/text/wordCount.ts": moduleSource(
      "wordCount",
      `(input: string): number {\n  return input.split(/\\s+/).filter(Boolean).length;\n}`,
      "Counts whitespace-separated words.",
    ),
    "src/money/formatCurrency.ts": moduleSource(
      "formatCurrency",
      `(cents: number, currency = "USD"): string {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);\n}`,
      "Formats an amount in cents.",
    ),
    "src/money/parseAmount.ts": moduleSource(
      "parseAmount",
      `(input: string): number {\n  return Math.round(Number(input.replace(/[^0-9.-]/g, "")) * 100);\n}`,
      "Parses a display amount into cents.",
    ),
    "src/money/sumCents.ts": moduleSource(
      "sumCents",
      `(values: ReadonlyArray<number>): number {\n  return values.reduce((total, value) => total + value, 0);\n}`,
      "Adds amounts in cents.",
    ),
    "src/dates/addDays.ts": moduleSource(
      "addDays",
      `(date: Date, days: number): Date {\n  const next = new Date(date);\n  next.setUTCDate(next.getUTCDate() + days);\n  return next;\n}`,
      "Adds whole days in UTC.",
    ),
    "src/dates/isWeekend.ts": moduleSource(
      "isWeekend",
      `(date: Date): boolean {\n  const day = date.getUTCDay();\n  return day === 0 || day === 6;\n}`,
      "True on Saturday and Sunday (UTC).",
    ),
    "src/dates/startOfMonth.ts": moduleSource(
      "startOfMonth",
      `(date: Date): Date {\n  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));\n}`,
      "First day of the month in UTC.",
    ),
    "src/collections/chunk.ts": moduleSource(
      "chunk",
      `<T>(values: ReadonlyArray<T>, size: number): T[][] {\n  const chunks: T[][] = [];\n  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));\n  return chunks;\n}`,
      "Splits an array into chunks of `size`.",
    ),
    "src/collections/groupBy.ts": moduleSource(
      "groupBy",
      `<T>(values: ReadonlyArray<T>, key: (value: T) => string): Record<string, T[]> {\n  const groups: Record<string, T[]> = {};\n  for (const value of values) (groups[key(value)] ??= []).push(value);\n  return groups;\n}`,
      "Groups values by a string key.",
    ),
    "src/collections/uniqueBy.ts": moduleSource(
      "uniqueBy",
      `<T>(values: ReadonlyArray<T>, key: (value: T) => string): T[] {\n  const seen = new Set<string>();\n  return values.filter((value) => (seen.has(key(value)) ? false : (seen.add(key(value)), true)));\n}`,
      "Keeps the first value for each key.",
    ),
    "src/invoices/invoiceTotal.ts": `import { formatCurrency } from "../money/formatCurrency.ts";\nimport { sumCents } from "../money/sumCents.ts";\n\n/** Formats an invoice total. */\nexport function invoiceTotal(lines: ReadonlyArray<{ cents: number }>): string {\n  return formatCurrency(sumCents(lines.map((line) => line.cents)));\n}\n`,
    "src/invoices/invoiceLine.ts": `import { formatCurrency } from "../money/formatCurrency.ts";\n\n/** Formats one invoice line. */\nexport function invoiceLine(label: string, cents: number): string {\n  return \`\${label}: \${formatCurrency(cents)}\`;\n}\n`,
    "src/invoices/invoiceNumber.ts": moduleSource(
      "invoiceNumber",
      `(sequence: number): string {\n  return \`INV-\${String(sequence).padStart(6, "0")}\`;\n}`,
      "Formats an invoice number.",
    ),
    "src/reports/revenueSummary.ts": `import { formatCurrency } from "../money/formatCurrency.ts";\n\n/** One-line revenue summary. */\nexport function revenueSummary(totalCents: number, months: number): string {\n  return \`\${formatCurrency(totalCents)} over \${months} months\`;\n}\n`,
    "src/reports/monthlyBreakdown.ts": `import { formatCurrency } from "../money/formatCurrency.ts";\n\n/** Formats a month-by-month table. */\nexport function monthlyBreakdown(rows: ReadonlyArray<{ month: string; cents: number }>): string {\n  return rows.map((row) => \`\${row.month}\\t\${formatCurrency(row.cents, "EUR")}\`).join("\\n");\n}\n`,
    "src/reports/headcount.ts": moduleSource(
      "headcount",
      `(teams: Record<string, number>): number {\n  return Object.values(teams).reduce((total, count) => total + count, 0);\n}`,
      "Total people across teams.",
    ),
    "src/users/displayName.ts": moduleSource(
      "displayName",
      `(user: { first: string; last: string }): string {\n  return \`\${user.first} \${user.last}\`.trim();\n}`,
      "Full display name.",
    ),
    "src/users/initials.ts": moduleSource(
      "initials",
      `(user: { first: string; last: string }): string {\n  return \`\${user.first.charAt(0)}\${user.last.charAt(0)}\`.toUpperCase();\n}`,
      "Two-letter initials.",
    ),
    "src/users/isAdult.ts": moduleSource(
      "isAdult",
      `(birthYear: number, currentYear: number): boolean {\n  return currentYear - birthYear >= 18;\n}`,
      "Age check by year.",
    ),
    "src/validation/isEmail.ts": moduleSource(
      "isEmail",
      `(input: string): boolean {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input);\n}`,
      "Loose email shape check.",
    ),
    "src/validation/isUrl.ts": moduleSource(
      "isUrl",
      `(input: string): boolean {\n  return URL.canParse(input);\n}`,
      "True when the input parses as a URL.",
    ),
    "src/validation/clamp.ts": moduleSource(
      "clamp",
      `(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}`,
      "Clamps a number to a range.",
    ),
    "src/index.ts": [
      "export { slugify } from './text/slugify.ts';",
      "export { truncate } from './text/truncate.ts';",
      "export { formatCurrency } from './money/formatCurrency.ts';",
      "export { invoiceTotal } from './invoices/invoiceTotal.ts';",
      "export { revenueSummary } from './reports/revenueSummary.ts';",
      "",
    ].join("\n"),
    "test/slugify.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/text/slugify.ts";\n\ntest("lower-cases and joins words", () => {\n  assert.equal(slugify("Hello World"), "hello-world");\n});\n\ntest("collapses repeated separators", () => {\n  assert.equal(slugify("Hello,  World!!  Again"), "hello-world-again");\n});\n`,
    "test/truncate.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { truncate } from "../src/text/truncate.ts";\n\ntest("keeps short input", () => {\n  assert.equal(truncate("abc", 5), "abc");\n});\n`,
    ".gitignore": "node_modules\n",
  };
  return files;
}

/**
 * Writes a fresh fixture repository into `directory` (which must not exist
 * yet) and commits it once.
 */
export function createFixtureRepo(directory: string): string {
  NodeFS.mkdirSync(directory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(fixtureFiles())) {
    const target = NodePath.join(directory, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  }
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=Bench",
    "-c",
    "user.email=bench@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return directory;
}

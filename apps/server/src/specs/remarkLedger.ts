import type {
  SpecRemark,
  SpecRemarkDocument,
  SpecRemarkEvent,
  SpecRemarkEventType,
  SpecRemarkKind,
  SpecRemarkOperation,
  SpecRemarkSection,
  SpecRemarkSelection,
  SpecRemarkStatus,
} from "@t3tools/contracts";

import { isJsonObject, parseJsonObject, type JsonObject } from "./baseFiles.ts";

// The BASE review panel's ledger, read and rewritten without loss: every function returns a copy
// that still carries whatever fields and entries Par3 does not know about.

export const REMARK_DOCUMENTS: ReadonlyArray<SpecRemarkDocument> = [
  "spec.md",
  "prd.md",
  "tech-analysis.md",
];

export const documentPath = (slug: string, document: SpecRemarkDocument) =>
  `specs/${slug}/${document}`;

export const ledgerPath = (slug: string, document: SpecRemarkDocument) =>
  `specs/${slug}/${document.replace(/\.md$/, "-comments.json")}`;

const EVENT_TYPES: ReadonlyArray<SpecRemarkEventType> = [
  "created",
  "submitted",
  "addressed",
  "unmatched",
  "deleted",
];
const KINDS: ReadonlyArray<SpecRemarkKind> = ["comment", "text-edit"];
const OPERATIONS: ReadonlyArray<SpecRemarkOperation> = ["comment", "delete", "add", "reword"];

const oneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
  typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

export function emptyLedger(document: string, now: string): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schemaVersion: "1.0.0",
    documentPath: document,
    createdAt: now,
    updatedAt: now,
    entries: [],
  };
}

/** The ledger when the text is a JSON object with an `entries` list, otherwise undefined. */
export function parseLedger(text: string): JsonObject | undefined {
  const parsed = parseJsonObject(text);
  return parsed && Array.isArray(parsed.entries) ? parsed : undefined;
}

const eventsOf = (entry: JsonObject): JsonObject[] =>
  Array.isArray(entry.events) ? entry.events.filter(isJsonObject) : [];

/** The type of an entry's last event; an entry with none has only been written, so it is pending. */
export function entryStatus(entry: JsonObject): SpecRemarkStatus {
  const last = eventsOf(entry).at(-1)?.type;
  if (last === "created" || last === undefined) return "pending";
  return oneOf(EVENT_TYPES, last) ? (last as SpecRemarkStatus) : "pending";
}

export const isOpen = (status: SpecRemarkStatus) => status === "pending" || status === "submitted";

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

function viewEvents(entry: JsonObject): SpecRemarkEvent[] {
  return eventsOf(entry).flatMap((event) =>
    typeof event.eventId === "string" &&
    typeof event.timestamp === "string" &&
    oneOf(EVENT_TYPES, event.type)
      ? [
          {
            eventId: event.eventId,
            type: event.type,
            timestamp: event.timestamp,
            ...(typeof event.response === "string" ? { response: event.response } : {}),
          },
        ]
      : [],
  );
}

/** The entry as clients see it, or undefined for one too malformed to show. */
export function viewEntry(entry: unknown): SpecRemark | undefined {
  if (
    !isJsonObject(entry) ||
    typeof entry.id !== "string" ||
    !oneOf(KINDS, entry.kind) ||
    !oneOf(OPERATIONS, entry.operation) ||
    typeof entry.createdAt !== "string" ||
    !isJsonObject(entry.section) ||
    typeof entry.section.heading !== "string"
  )
    return undefined;
  const selection = isJsonObject(entry.selection) ? entry.selection : undefined;
  const events = viewEvents(entry);
  const response = events
    .toReversed()
    .find((event) => event.type === "addressed" || event.type === "unmatched")?.response;
  return {
    id: entry.id,
    kind: entry.kind,
    operation: entry.operation,
    createdAt: entry.createdAt,
    section: {
      heading: entry.section.heading,
      ...(typeof entry.section.text === "string" ? { text: entry.section.text } : {}),
    },
    ...(selection && typeof selection.text === "string"
      ? {
          selection: {
            text: selection.text,
            ...(typeof selection.prefix === "string" ? { prefix: selection.prefix } : {}),
            ...(typeof selection.suffix === "string" ? { suffix: selection.suffix } : {}),
          },
        }
      : {}),
    ...(optionalString(entry.comment) === undefined ? {} : { comment: entry.comment as string }),
    ...(optionalString(entry.value) === undefined ? {} : { value: entry.value as string }),
    status: entryStatus(entry),
    ...(response === undefined ? {} : { response }),
    events,
  };
}

export const viewEntries = (ledger: JsonObject): SpecRemark[] =>
  (ledger.entries as unknown[]).flatMap((entry) => {
    const view = viewEntry(entry);
    return view ? [view] : [];
  });

export interface NewRemark {
  readonly kind: SpecRemarkKind;
  readonly operation: SpecRemarkOperation;
  readonly section: SpecRemarkSection;
  readonly selection?: SpecRemarkSelection | undefined;
  readonly comment?: string | undefined;
  readonly value?: string | undefined;
}

/** Why a remark would not mean anything to the agent that processes it, or undefined. */
export function remarkProblem(input: NewRemark): string | undefined {
  if (input.section.heading.trim() === "") return "Name the section the remark belongs to.";
  const hasComment = (input.comment ?? "").trim() !== "";
  const hasValue = (input.value ?? "").trim() !== "";
  const hasSelection = (input.selection?.text ?? "") !== "";
  if (input.kind === "comment")
    return input.operation !== "comment"
      ? "A comment has the operation comment."
      : hasComment
        ? undefined
        : "Write the comment.";
  if (input.operation === "comment") return "A text edit deletes, adds or rewords text.";
  if ((input.operation === "delete" || input.operation === "reword") && !hasSelection)
    return "Select the text to change.";
  if ((input.operation === "add" || input.operation === "reword") && !hasValue)
    return input.operation === "add" ? "Write the text to add." : "Write the replacement text.";
  return undefined;
}

export function buildEntry(
  input: NewRemark,
  ids: { readonly id: string; readonly eventId: string },
  now: string,
): JsonObject {
  return {
    id: ids.id,
    kind: input.kind,
    operation: input.operation,
    createdAt: now,
    section: {
      heading: input.section.heading,
      ...(input.section.text === undefined ? {} : { text: input.section.text }),
    },
    ...(input.selection === undefined
      ? {}
      : {
          selection: {
            text: input.selection.text,
            ...(input.selection.prefix === undefined ? {} : { prefix: input.selection.prefix }),
            ...(input.selection.suffix === undefined ? {} : { suffix: input.selection.suffix }),
          },
        }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.value === undefined ? {} : { value: input.value }),
    events: [{ eventId: ids.eventId, type: "created", timestamp: now }],
  };
}

export const appendEntry = (ledger: JsonObject, entry: JsonObject, now: string): JsonObject => ({
  ...ledger,
  updatedAt: now,
  entries: [...(ledger.entries as unknown[]), entry],
});

export type EventResult =
  | { readonly ok: true; readonly ledger: JsonObject; readonly entry: SpecRemark }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "closed";
      readonly status?: SpecRemarkStatus;
    };

/**
 * Appends one lifecycle event to the entry with this id, which must be in one of the `from`
 * statuses. Older entries and events are carried over untouched.
 */
export function appendEvent(
  ledger: JsonObject,
  id: string,
  event: {
    readonly eventId: string;
    readonly type: SpecRemarkEventType;
    readonly response?: string | undefined;
  },
  from: ReadonlyArray<SpecRemarkStatus>,
  now: string,
): EventResult {
  const entries = ledger.entries as unknown[];
  const index = entries.findIndex((entry) => isJsonObject(entry) && entry.id === id);
  if (index === -1) return { ok: false, reason: "not-found" };
  const target = entries[index] as JsonObject;
  const status = entryStatus(target);
  if (!from.includes(status)) return { ok: false, reason: "closed", status };
  const next: JsonObject = {
    ...target,
    events: [
      ...(Array.isArray(target.events) ? target.events : []),
      {
        eventId: event.eventId,
        type: event.type,
        timestamp: now,
        ...(event.response === undefined ? {} : { response: event.response }),
      },
    ],
  };
  const view = viewEntry(next);
  if (!view) return { ok: false, reason: "not-found" };
  return {
    ok: true,
    ledger: {
      ...ledger,
      updatedAt: now,
      entries: entries.map((entry, i) => (i === index ? next : entry)),
    },
    entry: view,
  };
}

/** Ids of the entries a send would hand to the agent, in ledger order, with their statuses. */
export function openEntries(ledger: JsonObject): Array<{ id: string; status: SpecRemarkStatus }> {
  return (ledger.entries as unknown[]).flatMap((entry) => {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || !viewEntry(entry)) return [];
    const status = entryStatus(entry);
    return isOpen(status) ? [{ id: entry.id, status }] : [];
  });
}

/** The first message of the thread that processes a send. */
export function remarksPrompt(input: {
  readonly documentPath: string;
  readonly commentsPath: string;
  readonly ids: ReadonlyArray<string>;
}) {
  return [
    "This request was sent from the BASE document review panel. Follow the `process-document-comments` skill.",
    "",
    `Read the source document at ${input.documentPath} and its review ledger at ${input.commentsPath}. Process only these open request UUIDs:`,
    ...input.ids,
    "",
    "For every listed request, preserve the original entry and record one new lifecycle event. If the request matches the document, apply the requested change to the document, then mark the request addressed with a concise response. If it cannot be matched or applied (for example the quoted text is gone, or the request is ambiguous), leave the document alone and mark the request unmatched, with the reason as the response. Do not touch requests that are not listed.",
    "",
    "Never delete ledger history: do not edit or remove existing entries or events, and do not write the ledger file yourself. Record each result with the spec_resolve_remark tool (document, id, outcome addressed or unmatched, response). Change spec.md with spec_update, and prd.md or tech-analysis.md with spec_write_artifact.",
  ].join("\n");
}

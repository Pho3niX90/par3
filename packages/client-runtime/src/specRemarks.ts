import type {
  SpecRemark,
  SpecRemarkDocument,
  SpecRemarkLedgerView,
  SpecRemarkStatus,
  SpecRemarksView,
} from "@t3tools/contracts";

// Rules for showing and sending the review remarks of a BASE spec, shared by every client so the
// list, the counts and the warning before a re-send cannot drift apart.

/** A remark is open until an agent resolves it or a person withdraws it. */
export const isOpenRemark = (status: SpecRemarkStatus) =>
  status === "pending" || status === "submitted";

export type SpecRemarkFilter = "open" | "all";

export const visibleRemarks = (
  entries: ReadonlyArray<SpecRemark>,
  filter: SpecRemarkFilter,
): ReadonlyArray<SpecRemark> =>
  filter === "all" ? entries : entries.filter((entry) => isOpenRemark(entry.status));

export const countOpenRemarks = (entries: ReadonlyArray<SpecRemark>) =>
  entries.filter((entry) => isOpenRemark(entry.status)).length;

export type SpecRemarkCounts = Readonly<Record<SpecRemarkStatus, number>> & {
  readonly open: number;
};

export function countRemarks(entries: ReadonlyArray<SpecRemark>): SpecRemarkCounts {
  const counts: Record<SpecRemarkStatus, number> = {
    pending: 0,
    submitted: 0,
    addressed: 0,
    unmatched: 0,
    deleted: 0,
  };
  for (const entry of entries) counts[entry.status] += 1;
  return { ...counts, open: counts.pending + counts.submitted };
}

const STATUS_LABELS: Readonly<Record<SpecRemarkStatus, string>> = {
  pending: "Pending",
  submitted: "Submitted",
  addressed: "Addressed",
  unmatched: "Unmatched",
  deleted: "Deleted",
};
export const remarkStatusLabel = (status: SpecRemarkStatus) => STATUS_LABELS[status];

const DOCUMENT_LABELS: Readonly<Record<SpecRemarkDocument, string>> = {
  "spec.md": "Spec",
  "prd.md": "PRD",
  "tech-analysis.md": "Tech analysis",
};
export const remarkDocumentLabel = (document: SpecRemarkDocument) => DOCUMENT_LABELS[document];

/** Only a remark that was never sent can be withdrawn. */
export const canDeleteRemark = (entry: SpecRemark) => entry.status === "pending";

export interface RemarksSendPlan {
  readonly canSend: boolean;
  /** Every open remark, in the order the agent will be told about them. */
  readonly open: number;
  /** Open remarks that were already sent and would be sent again. */
  readonly resend: number;
  /** What to confirm before sending, or null when there is nothing to warn about. */
  readonly warning: string | null;
}

export function planRemarksSend(entries: ReadonlyArray<SpecRemark>): RemarksSendPlan {
  const open = countOpenRemarks(entries);
  const resend = entries.filter((entry) => entry.status === "submitted").length;
  return {
    canSend: open > 0,
    open,
    resend,
    warning:
      resend === 0
        ? null
        : resend === 1
          ? "1 remark was already sent. Sending again asks the agent to process it a second time."
          : `${resend} remarks were already sent. Sending again asks the agent to process them a second time.`,
  };
}

/** A one-line excerpt for lists, cut at a word where it can be. */
export function remarkExcerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The documents to offer for review: the spec always, the others once they exist. */
export function reviewDocuments(
  remarks: SpecRemarksView | null | undefined,
): ReadonlyArray<SpecRemarkDocument> {
  const others = (remarks?.documents ?? []).filter(
    (item) => item.document !== "spec.md" && item.exists,
  );
  return ["spec.md", ...others.map((item) => item.document)];
}

export const remarkLedgerFor = (
  remarks: SpecRemarksView | null | undefined,
  document: SpecRemarkDocument,
): SpecRemarkLedgerView | undefined =>
  remarks?.documents.find((item) => item.document === document);

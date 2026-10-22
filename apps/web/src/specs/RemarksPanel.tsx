import {
  canDeleteRemark,
  countRemarks,
  planRemarksSend,
  remarkExcerpt,
  remarkStatusLabel,
  visibleRemarks,
  type SpecRemarkFilter,
} from "@t3tools/client-runtime/spec-remarks";
import type { SpecRemark, SpecRemarkOperation, SpecRemarkStatus } from "@t3tools/contracts";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";

const STATUS_VARIANT: Record<
  SpecRemarkStatus,
  "secondary" | "info" | "success" | "warning" | "outline"
> = {
  pending: "secondary",
  submitted: "info",
  addressed: "success",
  unmatched: "warning",
  deleted: "outline",
};

const OPERATION_LABEL: Record<SpecRemarkOperation, string> = {
  comment: "Comment",
  delete: "Suggested delete",
  add: "Suggested addition",
  reword: "Suggested rewording",
};

function RemarkRow({
  remark,
  canMutate,
  busy,
  onDelete,
}: {
  readonly remark: SpecRemark;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onDelete: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[remark.status]}>{remarkStatusLabel(remark.status)}</Badge>
        <span className="text-xs text-muted-foreground">
          {OPERATION_LABEL[remark.operation]} · {remark.section.heading}
        </span>
        <div className="flex-1" />
        {canDeleteRemark(remark) && canMutate ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
        ) : null}
      </div>
      {remark.selection ? (
        <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {remarkExcerpt(remark.selection.text)}
        </blockquote>
      ) : null}
      {remark.value ? (
        <p>
          <span className="text-xs text-muted-foreground">
            {remark.operation === "add" ? "Add: " : "Replace with: "}
          </span>
          {remark.value}
        </p>
      ) : null}
      {remark.comment ? <p>{remark.comment}</p> : null}
      {remark.response ? (
        <p className="text-xs text-muted-foreground">Response: {remark.response}</p>
      ) : null}
    </li>
  );
}

export function RemarksPanel({
  entries,
  filter,
  canMutate,
  busy,
  onFilterChange,
  onDelete,
  onSend,
}: {
  readonly entries: ReadonlyArray<SpecRemark>;
  readonly filter: SpecRemarkFilter;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onFilterChange: (filter: SpecRemarkFilter) => void;
  readonly onDelete: (id: string) => void;
  readonly onSend: () => void;
}) {
  const counts = countRemarks(entries);
  const plan = planRemarksSend(entries);
  const shown = visibleRemarks(entries, filter);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">Remarks ({counts.open} open)</h3>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Switch
            id="show-all-remarks"
            size="sm"
            checked={filter === "all"}
            onCheckedChange={(checked) => onFilterChange(checked ? "all" : "open")}
          />
          <Label htmlFor="show-all-remarks">Show all</Label>
        </div>
        <Button size="sm" disabled={!canMutate || busy || !plan.canSend} onClick={onSend}>
          Send remarks
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {entries.length === 0
            ? "Select text in the document to add a remark."
            : "No open remarks."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((remark) => (
            <RemarkRow
              key={remark.id}
              remark={remark}
              canMutate={canMutate}
              busy={busy}
              onDelete={() => onDelete(remark.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

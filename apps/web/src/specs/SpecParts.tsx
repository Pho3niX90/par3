import type { SpecStatus } from "@t3tools/contracts";

import { T } from "gt-react";

import { Badge } from "../components/ui/badge";
import { formatSpecStatusBadgeVariant, formatSpecStatusLabel } from "./state";

export function SpecStatusBadge({ status }: { readonly status: SpecStatus }) {
  return (
    <Badge variant={formatSpecStatusBadgeVariant(status)}>{formatSpecStatusLabel(status)}</Badge>
  );
}

export function SpecApprovalBadge({
  status,
  approvalValid,
}: {
  readonly status: SpecStatus;
  readonly approvalValid: boolean;
}) {
  if (approvalValid)
    return (
      <Badge variant="success">
        <T>Approval valid</T>
      </Badge>
    );
  if (status === "approved" || status === "in-progress" || status === "implemented") {
    return (
      <Badge variant="warning">
        <T>Approval out of date</T>
      </Badge>
    );
  }
  return null;
}

export function formatSpecTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

import React from "react";
import { View } from "react-native";
import type { SpecStatus } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";

export interface SpecStatusBadgeProps {
  readonly status: SpecStatus;
  readonly approvalValid?: boolean;
  readonly showApprovalStatus?: boolean;
}

const STATUS_CONFIG: Record<
  SpecStatus,
  { label: string; icon: AppSymbolName; bgClass: string; textClass: string }
> = {
  draft: {
    label: "Draft",
    icon: "doc.text",
    bgClass: "bg-subtle",
    textClass: "text-foreground-muted",
  },
  review: {
    label: "In Review",
    icon: "clock",
    bgClass: "bg-warning-subtle",
    textClass: "text-warning",
  },
  approved: {
    label: "Approved",
    icon: "checkmark.circle",
    bgClass: "bg-success-subtle",
    textClass: "text-success",
  },
  "in-progress": {
    label: "In Progress",
    icon: "arrow.triangle.branch",
    bgClass: "bg-info-subtle",
    textClass: "text-info",
  },
  implemented: {
    label: "Implemented",
    icon: "checkmark.circle.fill",
    bgClass: "bg-primary-subtle",
    textClass: "text-primary",
  },
  done: {
    label: "Done",
    icon: "checkmark.circle.fill",
    bgClass: "bg-success-subtle",
    textClass: "text-success",
  },
  blocked: {
    label: "Blocked",
    icon: "exclamationmark.triangle",
    bgClass: "bg-danger-subtle",
    textClass: "text-danger",
  },
  rejected: {
    label: "Rejected",
    icon: "xmark.circle.fill",
    bgClass: "bg-danger-subtle",
    textClass: "text-danger",
  },
};

export function SpecStatusBadge(props: SpecStatusBadgeProps) {
  const config = STATUS_CONFIG[props.status] ?? STATUS_CONFIG.draft;

  return (
    <View className="flex-row items-center gap-1.5 flex-wrap">
      <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${config.bgClass}`}>
        <SymbolView name={config.icon} size={13} tintColorClassName={config.textClass} />
        <Text className={`text-xs font-t3-semibold ${config.textClass}`}>{config.label}</Text>
      </View>
      {props.showApprovalStatus && props.approvalValid === false && (
        <View className="flex-row items-center gap-1 rounded-full bg-danger-subtle px-2 py-0.5">
          <SymbolView name="exclamationmark.circle" size={12} tintColorClassName="text-danger" />
          <Text className="text-xs font-t3-medium text-danger">Approval Out of Date</Text>
        </View>
      )}
    </View>
  );
}

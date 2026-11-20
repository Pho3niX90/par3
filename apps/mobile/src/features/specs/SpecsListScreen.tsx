import React, { useState, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { RefreshControl } from "../../components/ui/RefreshControl";
import { useNavigation } from "@react-navigation/native";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentId, ProjectId, SpecSummary, SpecStatus } from "@t3tools/contracts";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useProjects } from "../../state/entities";
import { useProjectSpecs, useSpecPermissions } from "../../state/specs";
import { SpecStatusBadge } from "./SpecStatusBadge";

export interface SpecsListScreenProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const STATUS_FILTERS = [
  { value: "all", label: msg("All") },
  { value: "draft", label: msg("Draft") },
  { value: "review", label: msg("Review") },
  { value: "approved", label: msg("Approved") },
  { value: "in-progress", label: msg("In-progress") },
  { value: "implemented", label: msg("Implemented") },
  { value: "done", label: msg("Done") },
  { value: "blocked", label: msg("Blocked") },
  { value: "rejected", label: msg("Rejected") },
] as const;

export function SpecsListScreen(props: SpecsListScreenProps) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SpecStatus | "all">("all");

  const projects = useProjects();
  const currentProject = projects.find(
    (p) => p.environmentId === props.environmentId && p.id === props.projectId,
  );

  const { specs, isPending, error, refresh } = useProjectSpecs(
    props.environmentId,
    props.projectId,
  );
  const { canMutate } = useSpecPermissions(props.environmentId);

  const filteredSpecs = useMemo(() => {
    return specs.filter((spec) => {
      if (statusFilter !== "all" && spec.status !== statusFilter) return false;
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        return (
          spec.title.toLowerCase().includes(q) ||
          spec.slug.toLowerCase().includes(q) ||
          spec.workspacePath.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [specs, statusFilter, searchQuery]);

  return (
    <View className="flex-1 bg-sheet">
      <View className="px-4 pt-3 pb-2 gap-3 border-b border-border-subtle bg-surface">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 min-w-0 pr-2">
            <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
              {gt("{title} Specs", { title: currentProject?.title ?? gt("Project") })}
            </Text>
            {currentProject?.workspaceRoot ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={1} selectable>
                {currentProject.workspaceRoot}
              </Text>
            ) : null}
          </View>
          {canMutate && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Create Spec")}
              onPress={() =>
                navigation.navigate("SpecEditor", {
                  environmentId: props.environmentId,
                  projectId: props.projectId,
                  mode: "create",
                })
              }
              className="flex-row items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 active:opacity-80"
            >
              <SymbolView name="plus" size={14} tintColorClassName="text-accent-foreground" />
              <Text className="text-sm font-t3-semibold text-accent-foreground">
                <T>New Spec</T>
              </Text>
            </Pressable>
          )}
        </View>

        {/* Search Field */}
        <View className="flex-row items-center rounded-xl bg-card border border-border-subtle px-3 py-1.5">
          <SymbolView name="magnifyingglass" size={16} tintColorClassName="text-foreground-muted" />
          <AppTextInput
            accessibilityLabel={gt("Search specs")}
            placeholder={gt("Search specs by title or slug...")}
            className="flex-1 ml-2 text-sm text-foreground py-0.5"
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery("")} hitSlop={6}>
              <SymbolView name="xmark" size={16} tintColorClassName="text-foreground-muted" />
            </Pressable>
          )}
        </View>

        {/* Filter Pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 py-1"
        >
          {STATUS_FILTERS.map(({ value: status, label }) => {
            const active = statusFilter === status;
            return (
              <Pressable
                key={status}
                accessibilityRole="button"
                onPress={() => setStatusFilter(status)}
                className={`rounded-full px-3 py-1 border ${
                  active
                    ? "bg-foreground border-foreground"
                    : "bg-surface-subtle border-border-subtle"
                }`}
              >
                <Text
                  className={`text-xs font-t3-medium capitalize ${
                    active ? "text-background font-t3-bold" : "text-foreground-muted"
                  }`}
                >
                  {m(label)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 12,
          gap: 10,
        }}
        refreshControl={<RefreshControl refreshing={isPending} onRefresh={refresh} />}
      >
        {error !== null && specs.length === 0 ? (
          <EmptyState title={gt("Couldn't load specs")} detail={error} />
        ) : filteredSpecs.length === 0 ? (
          <EmptyState
            title={gt("No specs found")}
            detail={
              searchQuery.length > 0
                ? gt("No specs match your current search query.")
                : gt("Create a spec to begin structured requirements, review, and verification.")
            }
          />
        ) : (
          filteredSpecs.map((spec) => (
            <SpecSummaryCard
              key={spec.slug}
              spec={spec}
              onPress={() =>
                navigation.navigate("SpecDetail", {
                  environmentId: props.environmentId,
                  projectId: props.projectId,
                  slug: spec.slug,
                })
              }
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SpecSummaryCard(props: { readonly spec: SpecSummary; readonly onPress: () => void }) {
  const { spec, onPress } = props;
  const gt = useGT();
  const formattedDate = React.useMemo(() => {
    const d = new Date(spec.updatedAt);
    return isNaN(d.getTime()) ? spec.updatedAt : d.toLocaleDateString();
  }, [spec.updatedAt]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Spec {title}", { title: spec.title })}
      onPress={onPress}
      className="rounded-2xl border border-border-subtle bg-surface p-4 gap-2 active:opacity-75 shadow-sm"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-base font-t3-bold text-foreground flex-1 min-w-0" numberOfLines={1}>
          {spec.title}
        </Text>
        <SpecStatusBadge
          status={spec.status}
          approvalValid={spec.approvalValid}
          showApprovalStatus
        />
      </View>

      <View className="flex-row items-center gap-2">
        <Text className="text-xs font-mono text-foreground-muted" numberOfLines={1}>
          {spec.slug}
        </Text>
        <Text className="text-xs text-foreground-subtle">·</Text>
        <Text className="text-xs font-t3-medium text-foreground-muted">
          <T>
            Rev <Var>{spec.revision}</Var>
          </T>
        </Text>
        <Text className="text-xs text-foreground-subtle">·</Text>
        <Text className="text-xs text-foreground-muted">{formattedDate}</Text>
      </View>

      {spec.workspacePath ? (
        <Text className="text-xs text-foreground-subtle" numberOfLines={1}>
          {spec.workspacePath}
        </Text>
      ) : null}

      {spec.error ? (
        <View className="flex-row items-center gap-1.5 mt-1 rounded-lg bg-danger-subtle p-2">
          <SymbolView name="exclamationmark.triangle" size={14} tintColorClassName="text-danger" />
          <Text className="text-xs text-danger font-t3-medium flex-1" numberOfLines={2}>
            {spec.error}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

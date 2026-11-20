import React, { useState, useMemo } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { T, useGT, Var } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import {
  useSpecDetail,
  useSpecMutations,
  useSpecPermissions,
  explainSpecRoleSupport,
} from "../../state/specs";
import { SpecStatusBadge } from "./SpecStatusBadge";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export interface SpecDetailScreenProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: string;
}

export function SpecDetailScreen(props: SpecDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const gt = useGT();
  const selectDetail = useSelectWorkspaceDetail();
  const styles = useMarkdownPreviewStyles();

  const [activeTab, setActiveTab] = useState<
    "requirements" | "tasks" | "evidence" | "approval" | "threads"
  >("requirements");
  const [isActing, setIsActing] = useState(false);
  const [requestChangesVisible, setRequestChangesVisible] = useState(false);

  const projects = useProjects();
  const currentProject = projects.find(
    (p) => p.environmentId === props.environmentId && p.id === props.projectId,
  );

  const {
    detail: spec,
    isPending,
    error,
  } = useSpecDetail(props.environmentId, props.projectId, props.slug);
  const { runMutation } = useSpecMutations(props.environmentId, props.projectId);
  const { canMutate } = useSpecPermissions(props.environmentId);
  const createThread = useAtomCommand(threadEnvironment.create, {
    label: "create thread for spec",
    reportFailure: true,
  });

  const updatedAt = spec?.updatedAt;
  const formattedDate = useMemo(() => {
    if (!updatedAt) return "";
    const d = new Date(updatedAt);
    return isNaN(d.getTime()) ? updatedAt : d.toLocaleDateString();
  }, [updatedAt]);

  const handleReviewAction = async (action: "approve" | "reject" | "reopen" | "request-review") => {
    if (!spec || !canMutate) return;
    setIsActing(true);
    try {
      await runMutation(spec.slug, spec.revision, { action });
    } catch (err: any) {
      Alert.alert(gt("Action failed"), err?.message ?? gt("Unable to complete review action"));
    }
    setIsActing(false);
  };

  const submitRequestChanges = async () => {
    if (!spec || !canMutate) return;
    setIsActing(true);
    try {
      await runMutation(spec.slug, spec.revision, {
        action: "request-changes",
      });
      setRequestChangesVisible(false);
    } catch (err: any) {
      Alert.alert(gt("Failed to request changes"), err?.message ?? gt("Unable to request changes"));
    }
    setIsActing(false);
  };

  const handleStartImplementation = async () => {
    if (!spec || !canMutate) return;

    // Validate provider support for implementation role
    // Default provider or check capability
    const driver = "claudeAgent";
    const explanation = explainSpecRoleSupport(driver, "implementation");
    if (explanation) {
      Alert.alert(gt("Provider Limit"), explanation);
      return;
    }

    const modelSelection = currentProject?.defaultModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    setIsActing(true);
    try {
      const newThreadId = uuidv4() as ThreadId;

      // 1. Create normal thread WITHOUT start
      const createResult = await createThread({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          threadId: newThreadId,
          title: gt("Implement {title}", { title: spec.title }),
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });

      if (createResult._tag === "Failure") {
        Alert.alert(
          gt("Failed to start implementation"),
          gt("Failed to create thread for implementation"),
        );
        setIsActing(false);
        return;
      }

      // 2. Bind spec before first send
      await runMutation(spec.slug, spec.revision, {
        action: "bind",
        role: "implementation",
        threadId: newThreadId,
      });

      // 3. Navigate to thread
      selectDetail({
        name: "Thread",
        params: { environmentId: props.environmentId, threadId: newThreadId },
      });
    } catch (err: any) {
      Alert.alert(
        gt("Failed to start implementation"),
        err?.message ?? gt("Could not create bound thread"),
      );
    }
    setIsActing(false);
  };

  const handleConfirmEvidence = async (evidenceId: string) => {
    if (!spec || !canMutate) return;
    setIsActing(true);
    try {
      await runMutation(spec.slug, spec.revision, {
        action: "confirm-evidence",
        evidenceId,
      });
    } catch (err: any) {
      Alert.alert(
        gt("Failed to confirm evidence"),
        err?.message ?? gt("Could not confirm evidence"),
      );
    }
    setIsActing(false);
  };

  const handleUnbindThread = async (threadId: ThreadId) => {
    if (!spec || !canMutate) return;
    setIsActing(true);
    try {
      await runMutation(
        spec.slug,
        spec.revision,
        {
          action: "unbind",
        },
        threadId,
      );
    } catch (err: any) {
      Alert.alert(gt("Failed to unbind thread"), err?.message ?? gt("Could not unbind thread"));
    }
    setIsActing(false);
  };

  if (!spec && isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet">
        <AppActivityIndicator size="large" />
      </View>
    );
  }

  if (!spec) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet p-6">
        <SymbolView name="exclamationmark.triangle" size={32} tintColorClassName="text-danger" />
        <Text className="text-base font-t3-bold text-foreground mt-2">
          <T>Spec Not Found</T>
        </Text>
        <Text className="text-sm text-foreground-muted text-center mt-1">
          {error ? String(error) : gt("The requested spec could not be loaded.")}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {/* Header Info */}
      <View className="px-4 pt-3 pb-3 border-b border-border-subtle bg-surface gap-2">
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1 min-w-0">
            <Text className="text-xl font-t3-bold text-foreground" numberOfLines={2}>
              {spec.title}
            </Text>
            <View className="flex-row items-center gap-2 mt-1">
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
          </View>
          <SpecStatusBadge
            status={spec.status}
            approvalValid={spec.approvalValid}
            showApprovalStatus
          />
        </View>

        {spec.workspacePath ? (
          <Text className="text-xs text-foreground-subtle" numberOfLines={1} selectable>
            {spec.workspacePath}
          </Text>
        ) : null}

        {/* Approval Invalidation Notice */}
        {spec.approvalValid === false && (
          <View className="flex-row items-start gap-2 rounded-xl bg-danger-subtle p-2.5 mt-1">
            <SymbolView
              name="exclamationmark.triangle"
              size={16}
              tintColorClassName="text-danger"
            />
            <View className="flex-1">
              <Text className="text-xs font-t3-bold text-danger">
                <T>Approval Out of Date</T>
              </Text>
              <Text className="text-xs text-danger font-t3-medium mt-0.5">
                <T>
                  Requirements or project constitution have changed since approval was granted.
                  Review and re-approval required.
                </T>
              </Text>
            </View>
          </View>
        )}

        {/* Primary Action Row */}
        <View className="flex-row items-center gap-2 pt-1 flex-wrap">
          {canMutate && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Start Implementation")}
              disabled={isActing}
              onPress={handleStartImplementation}
              className="flex-row items-center gap-1.5 rounded-full bg-accent px-4 py-2 active:opacity-80"
            >
              <SymbolView name="play" size={14} tintColorClassName="text-accent-foreground" />
              <Text className="text-sm font-t3-semibold text-accent-foreground">
                <T>Start implementation</T>
              </Text>
            </Pressable>
          )}

          {canMutate && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Edit Requirements")}
              onPress={() =>
                navigation.navigate("SpecEditor", {
                  environmentId: props.environmentId,
                  projectId: props.projectId,
                  slug: spec.slug,
                  mode: "edit",
                })
              }
              className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-2 active:opacity-80"
            >
              <SymbolView name="pencil" size={14} tintColorClassName="text-foreground" />
              <Text className="text-sm font-t3-medium text-foreground">
                <T>Edit</T>
              </Text>
            </Pressable>
          )}

          {canMutate && spec.status !== "approved" && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Approve")}
              disabled={isActing}
              onPress={() => handleReviewAction("approve")}
              className="rounded-full bg-success-subtle px-3 py-2 active:opacity-80"
            >
              <Text className="text-sm font-t3-semibold text-success">
                <T>Approve</T>
              </Text>
            </Pressable>
          )}

          {canMutate && spec.status === "review" && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Request Changes")}
              disabled={isActing}
              onPress={() => setRequestChangesVisible(true)}
              className="rounded-full bg-warning-subtle px-3 py-2 active:opacity-80"
            >
              <Text className="text-sm font-t3-medium text-warning">
                <T>Request Changes</T>
              </Text>
            </Pressable>
          )}

          {canMutate && spec.status !== "rejected" && spec.status !== "done" && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Reject")}
              disabled={isActing}
              onPress={() => handleReviewAction("reject")}
              className="rounded-full bg-danger-subtle px-3 py-2 active:opacity-80"
            >
              <Text className="text-sm font-t3-medium text-danger">
                <T>Reject</T>
              </Text>
            </Pressable>
          )}

          {canMutate && (spec.status === "rejected" || spec.status === "done") && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Reopen")}
              disabled={isActing}
              onPress={() => handleReviewAction("reopen")}
              className="rounded-full bg-subtle px-3 py-2 active:opacity-80"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                <T>Reopen</T>
              </Text>
            </Pressable>
          )}
        </View>

        {/* Tab Navigation */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 pt-2"
        >
          {(
            [
              { id: "requirements", label: gt("Requirements") },
              { id: "tasks", label: gt("Tasks ({count})", { count: spec.tasks?.length ?? 0 }) },
              {
                id: "evidence",
                label: gt("Evidence ({count})", { count: spec.evidence?.length ?? 0 }),
              },
              { id: "approval", label: gt("Approval") },
              {
                id: "threads",
                label: gt("Threads ({count})", { count: spec.bindings?.length ?? 0 }),
              },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="button"
                onPress={() => setActiveTab(tab.id)}
                className={`rounded-full px-3 py-1 border ${
                  active
                    ? "bg-foreground border-foreground"
                    : "bg-surface-subtle border-border-subtle"
                }`}
              >
                <Text
                  className={`text-xs font-t3-medium ${
                    active ? "text-background font-t3-bold" : "text-foreground-muted"
                  }`}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Main Content Area */}
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 24) + 24,
          paddingHorizontal: 16,
          paddingTop: 16,
          gap: 16,
        }}
      >
        {activeTab === "requirements" && (
          <View className="rounded-2xl border border-border-subtle bg-surface p-4">
            <SelectableMarkdownText
              markdown={spec.content || gt("_No content provided._")}
              textStyle={styles.nativeTextStyle}
            />
          </View>
        )}

        {activeTab === "tasks" && (
          <View className="gap-3">
            {!spec.tasks || spec.tasks.length === 0 ? (
              <Text className="text-sm text-foreground-muted italic px-2">
                <T>No tasks defined for this spec.</T>
              </Text>
            ) : (
              spec.tasks.map((task) => (
                <View
                  key={task.id}
                  className="rounded-2xl border border-border-subtle bg-surface p-4 gap-2"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <Text
                      className="text-base font-t3-bold text-foreground flex-1"
                      numberOfLines={1}
                    >
                      {task.title}
                    </Text>
                    <View className="rounded-full bg-subtle px-2 py-0.5">
                      <Text className="text-xs font-t3-semibold capitalize text-foreground-muted">
                        {task.status}
                      </Text>
                    </View>
                  </View>

                  <Text className="text-xs font-mono text-foreground-muted">
                    <T>
                      ID: <Var>{task.id}</Var>
                    </T>
                  </Text>

                  {task.acs && task.acs.length > 0 && (
                    <View className="gap-1 mt-1">
                      <Text className="text-xs font-t3-semibold text-foreground-muted">
                        <T>Acceptance Criteria:</T>
                      </Text>
                      {task.acs.map((ac) => (
                        <Text key={ac} className="text-xs text-foreground pl-2">
                          • {ac}
                        </Text>
                      ))}
                    </View>
                  )}

                  {task.dependsOn && task.dependsOn.length > 0 && (
                    <Text className="text-xs text-foreground-muted mt-1">
                      <T>
                        Depends on: <Var>{task.dependsOn.join(", ")}</Var>
                      </T>
                    </Text>
                  )}

                  {task.verify ? (
                    <View className="rounded-lg bg-card p-2 border border-border-subtle mt-1">
                      <Text className="text-xs font-mono text-foreground-muted">{task.verify}</Text>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </View>
        )}

        {activeTab === "evidence" && (
          <View className="gap-3">
            {!spec.evidence || spec.evidence.length === 0 ? (
              <Text className="text-sm text-foreground-muted italic px-2">
                <T>No evidence recorded yet.</T>
              </Text>
            ) : (
              spec.evidence.map((ev) => (
                <View
                  key={ev.id}
                  className="rounded-2xl border border-border-subtle bg-surface p-4 gap-2"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <View className="flex-row items-center gap-1.5 flex-1 min-w-0">
                      <SymbolView
                        name={ev.passed ? "checkmark.circle" : "xmark.circle.fill"}
                        size={16}
                        tintColorClassName={ev.passed ? "text-success" : "text-danger"}
                      />
                      <Text
                        className="text-sm font-t3-bold text-foreground flex-1"
                        numberOfLines={1}
                      >
                        {ev.id}
                      </Text>
                    </View>
                    <View className="rounded-full bg-subtle px-2 py-0.5">
                      <Text className="text-xs font-t3-medium capitalize text-foreground-muted">
                        {ev.kind}
                      </Text>
                    </View>
                  </View>

                  <Text className="text-xs text-foreground">{ev.description}</Text>

                  {ev.checkpoint ? (
                    <Text className="text-xs font-mono text-foreground-muted">
                      <T>
                        Checkpoint: <Var>{ev.checkpoint}</Var>
                      </T>
                    </Text>
                  ) : null}

                  {ev.confirmedBy ? (
                    <View className="flex-row items-center gap-1 mt-1">
                      <SymbolView
                        name="checkmark.circle.fill"
                        size={12}
                        tintColorClassName="text-success"
                      />
                      <Text className="text-xs text-success font-t3-medium">
                        <T>
                          Confirmed by <Var>{ev.confirmedBy}</Var>
                        </T>
                      </Text>
                    </View>
                  ) : ev.kind === "manual" && canMutate ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={gt("Confirm Evidence")}
                      disabled={isActing}
                      onPress={() => handleConfirmEvidence(ev.id)}
                      className="self-start rounded-full bg-accent px-3 py-1 mt-1 active:opacity-80"
                    >
                      <Text className="text-xs font-t3-semibold text-accent-foreground">
                        <T>Confirm Evidence</T>
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        )}

        {activeTab === "approval" && (
          <View className="rounded-2xl border border-border-subtle bg-surface p-4 gap-3">
            <Text className="text-base font-t3-bold text-foreground">
              <T>Approval Verification</T>
            </Text>
            {spec.approval ? (
              <View className="gap-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    <T>Subject</T>
                  </Text>
                  <Text className="text-xs font-t3-semibold text-foreground">
                    {spec.approval.subject}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    <T>Label</T>
                  </Text>
                  <Text className="text-xs font-t3-semibold text-foreground">
                    {spec.approval.label}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    <T>Approved At</T>
                  </Text>
                  <Text className="text-xs font-t3-semibold text-foreground">
                    {spec.approval.approvedAt}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    <T>Revision</T>
                  </Text>
                  <Text className="text-xs font-mono text-foreground">
                    {spec.approval.revision}
                  </Text>
                </View>
                <View className="gap-1 mt-2">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    <T>Spec Hash</T>
                  </Text>
                  <Text
                    className="text-xs font-mono text-foreground-subtle bg-card p-2 rounded-lg"
                    selectable
                  >
                    {spec.approval.specHash}
                  </Text>
                </View>
                {spec.approval.constitutionHash ? (
                  <View className="gap-1">
                    <Text className="text-xs font-t3-medium text-foreground-muted">
                      <T>Constitution Hash</T>
                    </Text>
                    <Text
                      className="text-xs font-mono text-foreground-subtle bg-card p-2 rounded-lg"
                      selectable
                    >
                      {spec.approval.constitutionHash}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <Text className="text-sm text-foreground-muted italic">
                <T>No formal approval recorded for this spec yet.</T>
              </Text>
            )}

            {/* Findings */}
            {spec.findings && spec.findings.length > 0 && (
              <View className="border-t border-border-subtle pt-3 gap-2">
                <Text className="text-sm font-t3-bold text-foreground">
                  <T>Review Findings</T>
                </Text>
                {spec.findings.map((f) => (
                  <View
                    key={`${f.code}:${f.criterion ?? ""}:${f.message}`}
                    className="rounded-xl bg-card p-3 border border-border-subtle gap-1"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs font-mono font-t3-bold text-danger">{f.code}</Text>
                      {f.criterion ? (
                        <Text className="text-xs text-foreground-muted">{f.criterion}</Text>
                      ) : null}
                    </View>
                    <Text className="text-xs text-foreground">{f.message}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {activeTab === "threads" && (
          <View className="gap-3">
            {!spec.bindings || spec.bindings.length === 0 ? (
              <Text className="text-sm text-foreground-muted italic px-2">
                <T>No threads currently bound to this spec.</T>
              </Text>
            ) : (
              spec.bindings.map((binding) => (
                <View
                  key={binding.threadId}
                  className="rounded-2xl border border-border-subtle bg-surface p-4 flex-row items-center justify-between gap-3"
                >
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      selectDetail({
                        name: "Thread",
                        params: { environmentId: props.environmentId, threadId: binding.threadId },
                      })
                    }
                    className="flex-1 min-w-0"
                  >
                    <View className="flex-row items-center gap-2">
                      <SymbolView
                        name="text.bubble"
                        size={16}
                        tintColorClassName="text-accent-icon"
                      />
                      <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
                        <T>
                          Thread <Var>{binding.threadId.slice(0, 8)}</Var>...
                        </T>
                      </Text>
                    </View>
                    <Text className="text-xs font-t3-medium text-foreground-muted capitalize mt-1">
                      <T>
                        Role: <Var>{binding.role}</Var>
                      </T>
                    </Text>
                  </Pressable>

                  {canMutate && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={gt("Unbind Thread")}
                      disabled={isActing}
                      onPress={() => handleUnbindThread(binding.threadId)}
                      className="rounded-full bg-danger-subtle px-3 py-1.5 active:opacity-80"
                    >
                      <Text className="text-xs font-t3-medium text-danger">
                        <T>Unbind</T>
                      </Text>
                    </Pressable>
                  )}
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>

      {/* Request Changes Modal */}
      <Modal
        visible={requestChangesVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRequestChangesVisible(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/50 p-4">
          <View className="w-full max-w-sm rounded-2xl bg-surface p-5 gap-3 border border-border-subtle shadow-lg">
            <Text className="text-lg font-t3-bold text-foreground">
              <T>Request Changes</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>Submit feedback requesting revisions to requirements or implementation plan.</T>
            </Text>
            <View className="flex-row items-center justify-end gap-2 mt-2">
              <Pressable
                accessibilityRole="button"
                onPress={() => setRequestChangesVisible(false)}
                className="rounded-full px-4 py-2 bg-subtle active:opacity-80"
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  <T>Cancel</T>
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isActing}
                onPress={submitRequestChanges}
                className="rounded-full px-4 py-2 bg-warning-subtle active:opacity-80"
              >
                <Text className="text-sm font-t3-semibold text-warning">
                  <T>Confirm Request</T>
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

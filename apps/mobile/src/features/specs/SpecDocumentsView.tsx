import {
  sectionHeadings,
  splitDocumentSegments,
  splitFrontmatter,
} from "@t3tools/client-runtime/spec-documents";
import {
  canDeleteRemark,
  countRemarks,
  planRemarksSend,
  remarkDocumentLabel,
  remarkExcerpt,
  remarkLedgerFor,
  remarkStatusLabel,
  reviewDocuments,
  visibleRemarks,
  type SpecRemarkFilter,
} from "@t3tools/client-runtime/spec-remarks";
import type {
  SpecDocument,
  SpecRemark,
  SpecRemarkDocument,
  SpecRemarksView,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import type { SpecActionOutcome } from "../../state/specs";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

type RunAction = (
  slug: string,
  expectedRevision: number,
  payload: Record<string, unknown> & { action: string },
) => Promise<SpecActionOutcome>;

const STATUS_TONE: Record<SpecRemark["status"], string> = {
  pending: "bg-subtle text-foreground-muted",
  submitted: "bg-info-subtle text-info",
  addressed: "bg-success-subtle text-success",
  unmatched: "bg-warning-subtle text-warning",
  deleted: "bg-subtle text-foreground-subtle",
};

const OPERATION_LABEL = {
  comment: "Comment",
  delete: "Suggested delete",
  add: "Suggested addition",
  reword: "Suggested rewording",
} as const;

function RemarkCard({
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
  const [badgeBackground, badgeText] = STATUS_TONE[remark.status].split(" ") as [string, string];
  return (
    <View className="gap-1.5 rounded-2xl border border-border-subtle bg-surface p-3">
      <View className="flex-row items-center gap-2">
        <View className={`rounded-full px-2 py-0.5 ${badgeBackground}`}>
          <Text className={`text-xs font-t3-semibold ${badgeText}`}>
            {remarkStatusLabel(remark.status)}
          </Text>
        </View>
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {OPERATION_LABEL[remark.operation]} · {remark.section.heading}
        </Text>
        {canMutate && canDeleteRemark(remark) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete remark"
            disabled={busy}
            hitSlop={8}
            onPress={onDelete}
            className="active:opacity-70"
          >
            <SymbolView name="trash" size={16} tintColorClassName="text-danger" />
          </Pressable>
        ) : null}
      </View>
      {remark.selection ? (
        <Text className="border-l-2 border-border-subtle pl-2 text-xs text-foreground-muted">
          {remarkExcerpt(remark.selection.text)}
        </Text>
      ) : null}
      {remark.value ? (
        <Text className="text-sm text-foreground">
          {remark.operation === "add" ? "Add: " : "Replace with: "}
          {remark.value}
        </Text>
      ) : null}
      {remark.comment ? <Text className="text-sm text-foreground">{remark.comment}</Text> : null}
      {remark.response ? (
        <Text className="text-xs text-foreground-muted">Response: {remark.response}</Text>
      ) : null}
    </View>
  );
}

/**
 * A BASE spec's documents on a phone: the spec, PRD and tech analysis, checklist items that can be
 * ticked, and the review remarks. Text cannot be selected for a remark here, so a remark is made
 * on a section chosen from the document's headings.
 */
export function SpecDocumentsView({
  spec,
  remarks,
  canMutate,
  runAction,
  onOpenThread,
}: {
  readonly spec: SpecDocument;
  readonly remarks: SpecRemarksView | null;
  readonly canMutate: boolean;
  readonly runAction: RunAction;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const documents = reviewDocuments(remarks);
  const [chosen, setChosen] = useState<SpecRemarkDocument>("spec.md");
  const document = documents.includes(chosen) ? chosen : "spec.md";
  const ledger = remarkLedgerFor(remarks, document);
  const entries = ledger?.entries ?? [];
  const source = document === "spec.md" ? spec.content : (ledger?.text ?? "");
  const { body, lineOffset } = splitFrontmatter(source);
  const segments = splitDocumentSegments(body);
  const headings = sectionHeadings(body);
  const label = remarkDocumentLabel(document);

  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<SpecRemarkFilter>("open");
  const [pickingSection, setPickingSection] = useState(false);
  const counts = countRemarks(entries);
  const plan = planRemarksSend(entries);
  const shown = visibleRemarks(entries, filter);

  const run = async (payload: Record<string, unknown> & { action: string }, failure: string) => {
    setBusy(true);
    const outcome = await runAction(spec.slug, spec.revision, { ...payload, document });
    setBusy(false);
    if (!outcome.ok) Dialog.alert(failure, outcome.message);
    return outcome;
  };

  const toggle = (line: number, text: string, checked: boolean) =>
    void run(
      { action: "checklist-toggle", line: line + lineOffset, expectedText: text, checked },
      "Could not update the checklist",
    );

  const addRemark = (heading: string) => {
    setPickingSection(false);
    Dialog.prompt({
      title: "Add remark",
      message: `${label} · ${heading}`,
      placeholder: "Your comment",
      initialValue: "",
      confirmText: "Add",
      onConfirm: (value) => {
        const comment = value.trim();
        if (comment === "") return;
        void run(
          {
            action: "remark-add",
            kind: "comment",
            operation: "comment",
            section: { heading },
            comment,
          },
          "Could not add the remark",
        );
      },
    });
  };

  const send = async () => {
    const outcome = await run({ action: "remarks-send" }, "Could not send the remarks");
    const threadId = outcome.ok ? outcome.result.sent?.threadId : undefined;
    if (threadId) onOpenThread(threadId);
  };

  return (
    <View className="gap-4">
      {documents.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          {documents.map((item) => {
            const active = item === document;
            return (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setChosen(item)}
                className={`rounded-full border px-3 py-1 ${
                  active
                    ? "border-foreground bg-foreground"
                    : "border-border-subtle bg-surface-subtle"
                }`}
              >
                <Text
                  className={`text-xs font-t3-medium ${
                    active ? "font-t3-bold text-background" : "text-foreground-muted"
                  }`}
                >
                  {remarkDocumentLabel(item)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <View className="gap-1 rounded-2xl border border-border-subtle bg-surface p-4">
        {segments.length === 0 ? (
          <Text className="text-sm italic text-foreground-muted">No content provided.</Text>
        ) : (
          segments.map((segment) =>
            segment.kind === "markdown" ? (
              <SelectableMarkdownText
                key={`m${segment.line}`}
                markdown={segment.text}
                textStyle={styles.nativeTextStyle}
              />
            ) : (
              <Pressable
                key={`t${segment.line}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: segment.checked, disabled: !canMutate || busy }}
                disabled={!canMutate || busy}
                onPress={() => toggle(segment.line, segment.text, !segment.checked)}
                style={{ paddingLeft: segment.depth * 20 }}
                className="min-h-11 flex-row items-center gap-3 py-1.5 active:opacity-70"
              >
                <SymbolView
                  name={segment.checked ? "checkmark.circle.fill" : "circle"}
                  size={22}
                  tintColorClassName={segment.checked ? "text-success" : "text-foreground-muted"}
                />
                <Text className="min-w-0 flex-1 text-sm text-foreground">{segment.label}</Text>
              </Pressable>
            ),
          )
        )}
      </View>

      {ledger?.error ? <Text className="text-xs text-warning">{ledger.error}</Text> : null}

      <View className="gap-3">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="flex-1 text-base font-t3-bold text-foreground">
            Remarks ({counts.open} open)
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setFilter(filter === "open" ? "all" : "open")}
            className="rounded-full bg-subtle px-3 py-1.5 active:opacity-80"
          >
            <Text className="text-xs font-t3-medium text-foreground">
              {filter === "open" ? "Show all" : "Show open"}
            </Text>
          </Pressable>
        </View>
        {canMutate ? (
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setPickingSection(true)}
              className="flex-row items-center gap-1.5 rounded-full bg-subtle px-4 py-2 active:opacity-80"
            >
              <SymbolView name="plus" size={14} tintColorClassName="text-foreground" />
              <Text className="text-sm font-t3-medium text-foreground">Add remark</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !plan.canSend}
              onPress={() =>
                plan.warning
                  ? Dialog.confirm({
                      title: "Send remarks again?",
                      message: plan.warning,
                      confirmText: `Send ${plan.open}`,
                      onConfirm: () => void send(),
                    })
                  : void send()
              }
              className={`rounded-full px-4 py-2 active:opacity-80 ${
                plan.canSend && !busy ? "bg-accent" : "bg-subtle-strong"
              }`}
            >
              <Text
                className={`text-sm font-t3-semibold ${
                  plan.canSend && !busy ? "text-accent-foreground" : "text-foreground-muted"
                }`}
              >
                Send remarks
              </Text>
            </Pressable>
          </View>
        ) : null}
        {shown.length === 0 ? (
          <Text className="text-sm italic text-foreground-muted">
            {entries.length === 0 ? "No remarks yet." : "No open remarks."}
          </Text>
        ) : (
          shown.map((remark) => (
            <RemarkCard
              key={remark.id}
              remark={remark}
              canMutate={canMutate}
              busy={busy}
              onDelete={() =>
                Dialog.confirm({
                  title: "Delete this remark?",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () =>
                    void run(
                      { action: "remark-delete", id: remark.id },
                      "Could not delete the remark",
                    ),
                })
              }
            />
          ))
        )}
      </View>

      <Modal
        visible={pickingSection}
        transparent
        animationType="fade"
        onRequestClose={() => setPickingSection(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/50 p-4">
          <View className="max-h-[70%] w-full max-w-sm gap-3 rounded-2xl border border-border-subtle bg-surface p-5">
            <Text className="text-lg font-t3-bold text-foreground">Which section?</Text>
            <ScrollView contentContainerClassName="gap-1">
              {(headings.length > 0 ? headings : [label]).map((heading) => (
                <Pressable
                  key={heading}
                  accessibilityRole="button"
                  onPress={() => addRemark(heading)}
                  className="min-h-11 justify-center rounded-xl px-3 py-2 active:bg-subtle"
                >
                  <Text className="text-sm text-foreground">{heading}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickingSection(false)}
              className="self-end rounded-full bg-subtle px-4 py-2 active:opacity-80"
            >
              <Text className="text-sm font-t3-medium text-foreground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

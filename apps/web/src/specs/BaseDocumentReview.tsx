import { lineAtOffset, splitFrontmatter } from "@t3tools/client-runtime/spec-documents";
import {
  planRemarksSend,
  remarkDocumentLabel,
  remarkLedgerFor,
  reviewDocuments,
  type SpecRemarkFilter,
} from "@t3tools/client-runtime/spec-remarks";
import type {
  EnvironmentId,
  ProjectId,
  SpecDocument,
  SpecRemarkDocument,
  SpecRemarksView,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { AddRemarkDialog, type NewRemark } from "./AddRemarkDialog";
import { RemarkSelectionBar, type RenderedSelection } from "./RemarkSelectionBar";
import { RemarksPanel } from "./RemarksPanel";
import { describeRemarkSelection } from "./specs.logic";
import { makeSpecRevision, useRunSpecMutation } from "./state";

/**
 * Review of a BASE spec's documents: tabs for the spec, PRD and tech analysis, checklists that can
 * be ticked, remarks on selected text, and sending the open remarks to an agent.
 */
export function BaseDocumentReview({
  environmentId,
  projectId,
  spec,
  remarks,
  canMutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly spec: SpecDocument;
  readonly remarks: SpecRemarksView | null;
  readonly canMutate: boolean;
}) {
  const navigate = useNavigate();
  const runMutation = useRunSpecMutation();
  const documents = reviewDocuments(remarks);
  const [chosen, setChosen] = useState<SpecRemarkDocument>("spec.md");
  const document = documents.includes(chosen) ? chosen : "spec.md";
  const ledger = remarkLedgerFor(remarks, document);
  const entries = ledger?.entries ?? [];
  const source = document === "spec.md" ? spec.content : (ledger?.text ?? "");
  const { body, lineOffset } = splitFrontmatter(source);
  const label = remarkDocumentLabel(document);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SpecRemarkFilter>("open");
  const [adding, setAdding] = useState<ReturnType<typeof describeRemarkSelection> | null>(null);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const run = async (payload: Parameters<typeof runMutation>[1]) => {
    setBusy(true);
    setError(null);
    const outcome = await runMutation(environmentId, payload);
    setBusy(false);
    if (!outcome.ok) setError(outcome.message);
    return outcome;
  };
  const target = { projectId, slug: spec.slug, document };

  // The checkbox reports where its `[ ]` sits in the text it was rendered from; the server wants the
  // source line and the text it expects to find there.
  const toggleTask = ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
    const at = lineAtOffset(body, markerOffset);
    void run({
      ...target,
      action: "checklist-toggle",
      expectedRevision: makeSpecRevision(spec.revision),
      line: at.line + lineOffset,
      expectedText: at.text,
      checked,
    });
  };

  const startRemark = (selected: RenderedSelection) =>
    setAdding(
      describeRemarkSelection({
        source: body,
        selected: selected.text,
        renderedBefore: selected.renderedBefore,
        renderedAfter: selected.renderedAfter,
        renderedHeading: selected.renderedHeading,
        documentLabel: label,
      }),
    );

  const addRemark = async (remark: NewRemark): Promise<string | null> => {
    if (!adding) return "Select some text first.";
    const outcome = await run({
      ...target,
      action: "remark-add",
      section: { heading: adding.heading },
      selection: adding.selection,
      ...remark,
    });
    return outcome.ok ? null : outcome.message;
  };

  const send = async () => {
    setConfirmingSend(false);
    const outcome = await run({ ...target, action: "remarks-send" });
    const threadId = outcome.ok ? outcome.document.sent?.threadId : undefined;
    if (threadId)
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  const plan = planRemarksSend(entries);

  return (
    <div className="flex flex-col gap-4">
      {documents.length > 1 ? (
        <ToggleGroup
          aria-label="Document"
          variant="segmented"
          value={[document]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked) setChosen(picked as SpecRemarkDocument);
          }}
        >
          {documents.map((item) => (
            <Toggle key={item} value={item}>
              {remarkDocumentLabel(item)}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {canMutate ? <RemarkSelectionBar containerRef={containerRef} onAdd={startRemark} /> : null}
      <div ref={containerRef} aria-busy={busy}>
        <ChatMarkdown
          key={document}
          text={body}
          cwd={spec.workspacePath}
          environmentId={environmentId}
          {...(canMutate && !busy ? { onTaskListChange: toggleTask } : {})}
        />
      </div>
      {ledger?.error ? (
        <Alert variant="warning">
          <AlertDescription>{ledger.error}</AlertDescription>
        </Alert>
      ) : null}
      <RemarksPanel
        entries={entries}
        filter={filter}
        canMutate={canMutate}
        busy={busy}
        onFilterChange={setFilter}
        onDelete={(id) => void run({ ...target, action: "remark-delete", id })}
        onSend={() => (plan.warning ? setConfirmingSend(true) : void send())}
      />
      {adding ? (
        <AddRemarkDialog
          documentLabel={label}
          heading={adding.heading}
          selection={adding.selection}
          onClose={() => setAdding(null)}
          onSubmit={addRemark}
        />
      ) : null}
      <AlertDialog open={confirmingSend} onOpenChange={setConfirmingSend}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Send remarks again?</AlertDialogTitle>
            <AlertDialogDescription>{plan.warning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void send()}>Send {plan.open} remarks</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

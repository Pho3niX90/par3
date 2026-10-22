import { parseDiffFromFile } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, FileDiff, Virtualizer } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  MergeConflictReadResult,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GitCompareIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { useTheme } from "~/hooks/useTheme";
import { FILE_LINK_REVEAL_UNSAFE_CSS } from "../files/fileSurfaceChrome";
import { useEditableAfterHighlight } from "../files/useEditableAfterHighlight";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MergeDivider } from "./MergeDivider";
import {
  chunkAtLine,
  findConflict,
  planApplyNonConflicting,
  planChunkAction,
  planResolveSimple,
  summarizeModel,
  type ActionContext,
  type ActionPlan,
  type ChunkAction,
  type ChunkState,
  type MergeSide,
} from "./mergeModel";
import { createMergeSession, discardMergeDraft, type MergeSession } from "./mergeSession";

/** The result pane's editor is created here so the view can reach it for chunk actions and undo. */
type MergeEditor = Editor<"file", undefined, undefined>;
const createMergeEditor: EditorFactory<undefined, undefined> = (editorType, options, key) =>
  new Editor(editorType, options, key);

export type MergeApplyOutcome =
  | { readonly status: "applied" }
  | { readonly status: "stale"; readonly message: string }
  | { readonly status: "failed" };

export interface ThreeWayMergeViewProps {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  /** A read of a text file with both sides present; never one with a `fileLevelReason`. */
  readonly file: MergeConflictReadResult;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Another conflicted file follows this one, so Apply moves on to it. */
  readonly hasNextFile: boolean;
  readonly onApply: (content: string) => Promise<MergeApplyOutcome>;
  readonly onCancel: () => void;
  /** Reads the file again, discarding what this view holds. */
  readonly onReload: () => void;
}

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Text of the result pane for one range of lines, as the chunk actions need it. */
function actionContext(editor: MergeEditor): ActionContext | null {
  const document = editor.getEditState()?.document;
  if (document === undefined) return null;
  return {
    textOf: (range) =>
      document.getText({
        start: { line: range.start, character: 0 },
        end: { line: range.end, character: 0 },
      }),
    lineCount: document.lineCount,
    endPosition: document.positionAt(document.getText().length),
  };
}

/**
 * Marks the editor's newest undo entry as a boundary, so a chunk action is its own undo step and
 * typing before or after it cannot merge into it.
 */
function closeUndoStep(editor: MergeEditor) {
  const entry = editor.getEditState()?.document.history.undoStack.at(-1);
  if (entry !== undefined) entry.undoBoundary = true;
}

function resultLineCount(editor: MergeEditor): number {
  const document = editor.getEditState()?.document;
  if (document === undefined) return 0;
  const last = document.lineCount - 1;
  return document.getLineLength(last) === 0 && last > 0 ? last : document.lineCount;
}

export function ThreeWayMergeView(props: ThreeWayMergeViewProps) {
  const [session] = useState(() => createMergeSession(props.cwd, props.file));
  return <MergeViewBody key={session.editStateKey} session={session} {...props} />;
}

function MergeViewBody(props: ThreeWayMergeViewProps & { readonly session: MergeSession }) {
  const { session, file } = props;
  const { controller, timeline, lines, merge } = session;
  const { resolvedTheme } = useTheme();
  const [model, setModel] = useState(timeline.model);
  const editorRef = useRef<MergeEditor | null>(null);
  const pendingStatesRef = useRef<ReadonlyMap<number, ChunkState> | undefined>(undefined);
  const appliedRef = useRef(false);
  const [attached, setAttached] = useState(false);
  const [applying, setApplying] = useState(false);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [comparison, setComparison] = useState<"ours" | "theirs" | null>(null);
  const dividers = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [bindOurs] = useState(
    () => (node: HTMLElement | null) => controller.registerPane("ours", node),
  );
  const [bindResult] = useState(
    () => (node: HTMLElement | null) => controller.registerPane("result", node),
  );
  const [bindTheirs] = useState(
    () => (node: HTMLElement | null) => controller.registerPane("theirs", node),
  );
  const resultFile = useState(() => ({
    name: file.path,
    contents: merge.initialResult,
    cacheKey: session.editStateKey,
  }))[0];
  const oursFile = useState(() => ({
    name: file.path,
    contents: file.ours ?? "",
    cacheKey: `${session.editStateKey}\0ours`,
  }))[0];
  const theirsFile = useState(() => ({
    name: file.path,
    contents: file.theirs ?? "",
    cacheKey: `${session.editStateKey}\0theirs`,
  }))[0];
  const { ready: editable, onPostRender: onEditablePostRender } =
    useEditableAfterHighlight(resultFile);

  useEffect(() => {
    controller.activate();
    return () => {
      controller.dispose();
      if (appliedRef.current) discardMergeDraft(session.editStateKey);
    };
  }, [controller, session.editStateKey]);

  useEffect(() => {
    controller.setModel(
      model,
      editorRef.current ? resultLineCount(editorRef.current) : lines.base.length,
    );
  }, [controller, model, lines.base.length]);

  const summary = summarizeModel(model);

  const handleEditChange = (event: {
    readonly changes: ReadonlyArray<unknown>;
    readonly editor: MergeEditor;
  }) => {
    const top = event.editor.getEditState()?.document.history.undoStack.at(-1);
    const planned = pendingStatesRef.current;
    pendingStatesRef.current = undefined;
    const next = timeline.update(
      top,
      event.changes as Parameters<typeof timeline.update>[1],
      planned,
    );
    setModel(next);
    controller.setModel(next, resultLineCount(event.editor));
  };

  const runPlan = (plan: ActionPlan | null) => {
    const editor = editorRef.current;
    if (plan === null || editor === null) return;
    pendingStatesRef.current = plan.states;
    closeUndoStep(editor);
    editor.applyEdits([...plan.edits]);
    closeUndoStep(editor);
    pendingStatesRef.current = undefined;
  };

  const withContext = (build: (context: ActionContext) => ActionPlan | null) => {
    const editor = editorRef.current;
    const context = editor === null ? null : actionContext(editor);
    if (context === null) return;
    runPlan(build(context));
  };

  const runChunkAction = (chunkId: number, action: ChunkAction) =>
    withContext((context) => planChunkAction(timeline.model, chunkId, action, context));

  const caretLine = (): number => {
    const selection = editorRef.current?.getViewState().selections?.at(-1);
    return selection === undefined ? controller.topResultLine() : selection.end.line;
  };

  const goToConflict = (direction: "next" | "previous") => {
    const chunk = findConflict(timeline.model, caretLine(), direction);
    if (chunk === null) return;
    controller.revealResultLine(chunk.result.start);
    editorRef.current?.setSelections([
      {
        start: { line: chunk.result.start, character: 0 },
        end: { line: chunk.result.start, character: 0 },
        direction: "none",
      },
    ]);
  };

  const acceptAtCaret = (side: MergeSide) => {
    const line = caretLine();
    const chunk = chunkAtLine(timeline.model, line) ?? findConflict(timeline.model, line, "next");
    if (chunk === null) return;
    runChunkAction(chunk.id, { type: "accept", side });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = resolveShortcutCommand(event.nativeEvent, props.keybindings, {
      context: { mergeViewFocus: true },
    });
    switch (command) {
      case "merge.nextConflict":
        goToConflict("next");
        break;
      case "merge.prevConflict":
        goToConflict("previous");
        break;
      case "merge.acceptOurs":
        acceptAtCaret("ours");
        break;
      case "merge.acceptTheirs":
        acceptAtCaret("theirs");
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const apply = async () => {
    setConfirmingApply(false);
    setApplying(true);
    setStaleMessage(null);
    const content = editorRef.current?.getText() ?? merge.initialResult;
    const outcome = await props.onApply(content);
    setApplying(false);
    if (outcome.status === "applied") appliedRef.current = true;
    if (outcome.status === "stale") setStaleMessage(outcome.message);
  };

  const requestApply = () => {
    if (summary.conflicts > 0) setConfirmingApply(true);
    else void apply();
  };

  const shortcut = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    shortcutLabelForCommand(props.keybindings, command, { context: { mergeViewFocus: true } });

  const sharedOptions = {
    disableFileHeader: true,
    overflow: "scroll" as const,
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
  };
  const virtualizerConfig = { overscrollSize: 600, intersectionObserverMargin: 1200 };
  const busy = applying || !attached;

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="three-way-merge-view"
      onKeyDownCapture={handleKeyDown}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium">{file.path}</span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous conflict"
                disabled={summary.conflicts === 0}
                onClick={() => goToConflict("previous")}
              />
            }
          >
            <ChevronUpIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Previous conflict {shortcut("merge.prevConflict") ?? ""}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next conflict"
                disabled={summary.conflicts === 0}
                onClick={() => goToConflict("next")}
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Next conflict {shortcut("merge.nextConflict") ?? ""}
          </TooltipPopup>
        </Tooltip>
        <span className="text-xs text-muted-foreground" role="status" data-testid="merge-counter">
          {pluralize(summary.changes, "change")} · {pluralize(summary.conflicts, "conflict")}
        </span>
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
            <WandSparklesIcon />
            Apply non-conflicting
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                withContext((context) => planApplyNonConflicting(timeline.model, "left", context))
              }
            >
              From the left
            </MenuItem>
            <MenuItem
              onClick={() =>
                withContext((context) => planApplyNonConflicting(timeline.model, "all", context))
              }
            >
              From both sides
            </MenuItem>
            <MenuItem
              onClick={() =>
                withContext((context) => planApplyNonConflicting(timeline.model, "right", context))
              }
            >
              From the right
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || summary.conflicts === 0}
          onClick={() => withContext((context) => planResolveSimple(timeline.model, context))}
        >
          <SparklesIcon />
          Resolve simple conflicts
        </Button>
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            <GitCompareIcon />
            Compare with base
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setComparison("ours")}>Base and ours</MenuItem>
            <MenuItem onClick={() => setComparison("theirs")}>Base and theirs</MenuItem>
          </MenuPopup>
        </Menu>
        <Button size="xs" variant="ghost" disabled={applying} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={busy} onClick={requestApply}>
          {applying ? <Spinner size="sm" /> : null}
          {props.hasNextFile ? "Apply and next file" : "Apply"}
        </Button>
      </div>

      {staleMessage ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          <span className="min-w-0 flex-1">{staleMessage}</span>
          <Button size="xs" variant="warning-outline" onClick={props.onReload}>
            Reload
          </Button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
        <PaneTitle>{file.labels.ours}</PaneTitle>
        <span />
        <PaneTitle>Result</PaneTitle>
        <span />
        <PaneTitle>{file.labels.theirs}</PaneTitle>

        <div ref={bindOurs} className="flex min-h-0 min-w-0 flex-col">
          <Virtualizer className="min-h-0 flex-1 overflow-auto" config={virtualizerConfig}>
            <File
              file={oursFile}
              options={{
                ...sharedOptions,
                onPostRender: (container, _instance, phase) =>
                  controller.handlePostRender("ours", container, phase),
              }}
              className="min-h-full"
            />
          </Virtualizer>
        </div>
        <MergeDivider
          side="ours"
          connectors={dividers.left}
          viewportHeight={dividers.viewportHeight}
          chunks={model.chunks}
          disabled={busy}
          onAction={runChunkAction}
        />
        <div ref={bindResult} className="flex min-h-0 min-w-0 flex-col">
          <EditProvider createEditor={createMergeEditor}>
            <Virtualizer className="min-h-0 flex-1 overflow-auto" config={virtualizerConfig}>
              <File
                file={resultFile}
                edit={editable}
                editStateKey={session.editStateKey}
                editorOptions={{
                  onAttach: (editor) => {
                    editorRef.current = editor as MergeEditor;
                    setAttached(true);
                  },
                  onComplete: () => {
                    editorRef.current = null;
                    setAttached(false);
                  },
                }}
                onEditChange={handleEditChange}
                options={{
                  ...sharedOptions,
                  onPostRender: (container, instance, phase) => {
                    onEditablePostRender(instance.file, phase);
                    controller.handlePostRender("result", container, phase);
                  },
                }}
                className="min-h-full"
              />
            </Virtualizer>
          </EditProvider>
        </div>
        <MergeDivider
          side="theirs"
          connectors={dividers.right}
          viewportHeight={dividers.viewportHeight}
          chunks={model.chunks}
          disabled={busy}
          onAction={runChunkAction}
        />
        <div ref={bindTheirs} className="flex min-h-0 min-w-0 flex-col">
          <Virtualizer className="min-h-0 flex-1 overflow-auto" config={virtualizerConfig}>
            <File
              file={theirsFile}
              options={{
                ...sharedOptions,
                onPostRender: (container, _instance, phase) =>
                  controller.handlePostRender("theirs", container, phase),
              }}
              className="min-h-full"
            />
          </Virtualizer>
        </div>
      </div>

      <AlertDialog open={confirmingApply} onOpenChange={setConfirmingApply}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply with conflicts left?</AlertDialogTitle>
            <AlertDialogDescription>
              {pluralize(summary.conflicts, "conflict")} still hold the base text. Applying keeps
              the result exactly as it is now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button onClick={() => void apply()}>Apply anyway</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <BaseComparisonDialog
        side={comparison}
        path={file.path}
        base={file.base ?? ""}
        ours={file.ours ?? ""}
        theirs={file.theirs ?? ""}
        theme={resolveDiffThemeName(resolvedTheme)}
        onClose={() => setComparison(null)}
      />
    </div>
  );
}

function PaneTitle(props: { readonly children: string }) {
  return (
    <div className="flex h-7 min-w-0 items-center border-b border-border/60 px-2 text-xs text-muted-foreground">
      <span className="truncate">{props.children}</span>
    </div>
  );
}

function BaseComparisonDialog(props: {
  readonly side: "ours" | "theirs" | null;
  readonly path: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly theme: ReturnType<typeof resolveDiffThemeName>;
  readonly onClose: () => void;
}) {
  const open = props.side !== null;
  // Only built while the dialog is open, so a view nobody compares in never pays for the diff.
  const fileDiff = open
    ? parseDiffFromFile(
        { name: props.path, contents: props.base },
        { name: props.path, contents: props.side === "ours" ? props.ours : props.theirs },
      )
    : null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Base compared with {props.side ?? "ours"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {fileDiff ? (
            <div className="max-h-[60vh] overflow-auto rounded-lg border text-xs">
              <FileDiff
                fileDiff={fileDiff}
                options={{ diffStyle: "unified", theme: props.theme, overflow: "wrap" }}
              />
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

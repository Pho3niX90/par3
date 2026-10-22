import { useEffect, useState, type RefObject } from "react";

import { remarkExcerpt } from "@t3tools/client-runtime/spec-remarks";

import { Button } from "../components/ui/button";

export interface RenderedSelection {
  readonly text: string;
  /** Rendered text around the selection, for context the markdown source cannot supply. */
  readonly renderedBefore: string;
  readonly renderedAfter: string;
  readonly renderedHeading: string | undefined;
}

const CONTEXT = 60;

function readSelection(container: HTMLElement): RenderedSelection | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (text.trim() === "") return null;

  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);

  // The nearest heading above the selection, preferring `##`.
  const preceding = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(
    (heading) =>
      heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const heading = preceding.findLast((item) => item.tagName === "H2") ?? preceding.at(-1);
  return {
    text,
    renderedBefore: before.toString().slice(-CONTEXT),
    renderedAfter: after.toString().slice(0, CONTEXT),
    renderedHeading: heading?.textContent ?? undefined,
  };
}

/**
 * Offers to remark on the text selected inside `containerRef`. It owns the selection state, so a
 * selection change re-renders this bar and not the document.
 */
export function RemarkSelectionBar({
  containerRef,
  onAdd,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly onAdd: (selection: RenderedSelection) => void;
}) {
  const [selection, setSelection] = useState<RenderedSelection | null>(null);

  useEffect(() => {
    const update = () => {
      const container = containerRef.current;
      const next = container ? readSelection(container) : null;
      setSelection((previous) => (previous?.text === next?.text ? previous : next));
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [containerRef]);

  if (!selection) return null;
  return (
    <div className="sticky top-2 z-10 flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs shadow-sm">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        “{remarkExcerpt(selection.text, 90)}”
      </span>
      <Button
        size="xs"
        // Keeps the selection while the button is pressed.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onAdd(selection)}
      >
        Add remark
      </Button>
    </div>
  );
}

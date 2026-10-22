import { remarkExcerpt } from "@t3tools/client-runtime/spec-remarks";
import type { SpecRemarkOperation, SpecRemarkSelection } from "@t3tools/contracts";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";

export interface NewRemark {
  readonly kind: "comment" | "text-edit";
  readonly operation: SpecRemarkOperation;
  readonly comment?: string;
  readonly value?: string;
}

type Mode = "comment" | SpecRemarkOperation;

const EDIT_LABELS = {
  delete: "Delete",
  add: "Add after",
  reword: "Reword",
} as const;

export function AddRemarkDialog({
  documentLabel,
  heading,
  selection,
  onClose,
  onSubmit,
}: {
  readonly documentLabel: string;
  readonly heading: string;
  readonly selection: SpecRemarkSelection;
  readonly onClose: () => void;
  /** Resolves to an error message, or null once the remark is saved. */
  readonly onSubmit: (remark: NewRemark) => Promise<string | null>;
}) {
  const [mode, setMode] = useState<Mode>("comment");
  const [comment, setComment] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsValue = mode === "add" || mode === "reword";
  const canSave =
    !saving && (mode === "comment" ? comment.trim() !== "" : !needsValue || value.trim() !== "");

  const save = async () => {
    setSaving(true);
    setError(null);
    const note = comment.trim();
    const message = await onSubmit(
      mode === "comment"
        ? { kind: "comment", operation: "comment", comment: note }
        : {
            kind: "text-edit",
            operation: mode,
            ...(needsValue ? { value } : {}),
            ...(note === "" ? {} : { comment: note }),
          },
    );
    setSaving(false);
    if (message === null) onClose();
    else setError(message);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add remark</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>
                {documentLabel} · {heading}
              </span>
              <blockquote className="border-l-2 border-border pl-2 text-foreground">
                {remarkExcerpt(selection.text, 280)}
              </blockquote>
            </div>
            <ToggleGroup
              aria-label="Kind of remark"
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const chosen = next[0];
                if (chosen) setMode(chosen as Mode);
              }}
            >
              <Toggle value="comment">Comment</Toggle>
              <Toggle value="delete">{EDIT_LABELS.delete}</Toggle>
              <Toggle value="add">{EDIT_LABELS.add}</Toggle>
              <Toggle value="reword">{EDIT_LABELS.reword}</Toggle>
            </ToggleGroup>
            {needsValue ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="remark-value">
                  {mode === "add" ? "Text to add" : "Replacement text"}
                </Label>
                <Textarea
                  id="remark-value"
                  value={value}
                  autoFocus
                  onChange={(event) => setValue(event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remark-comment">
                {mode === "comment" ? "Comment" : "Note (optional)"}
              </Label>
              <Textarea
                id="remark-comment"
                value={comment}
                autoFocus={!needsValue}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving" : "Add remark"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

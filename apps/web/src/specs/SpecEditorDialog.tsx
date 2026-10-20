import type { EnvironmentId, ProjectId, SpecDocument } from "@t3tools/contracts";
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
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { defaultSpecContent } from "./specs.logic";
import {
  isValidSpecSlug,
  makeSpecRevision,
  parseSpecSlugOrNull,
  slugifySpecTitle,
  useRunSpecMutation,
} from "./state";

export type SpecEditorTarget =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly spec: SpecDocument };

export function SpecEditorDialog({
  environmentId,
  projectId,
  target,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly target: SpecEditorTarget;
  readonly onClose: () => void;
  readonly onSaved: (spec: SpecDocument) => void;
}) {
  const runMutation = useRunSpecMutation();
  const editing = target.mode === "edit" ? target.spec : null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(false);
  const [content, setContent] = useState(editing?.content ?? defaultSpecContent(""));
  const [contentEdited, setContentEdited] = useState(editing !== null);
  const [supersedes, setSupersedes] = useState(editing?.supersedes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = editing ? editing.slug : slug;
  const slugInvalid = editing === null && slug.length > 0 && !isValidSpecSlug(slug);
  const supersedesSlug = supersedes.trim().length > 0 ? parseSpecSlugOrNull(supersedes) : null;
  const supersedesInvalid = supersedes.trim().length > 0 && supersedesSlug === null;
  const canSave =
    !saving &&
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    (editing !== null || isValidSpecSlug(slug)) &&
    !supersedesInvalid;

  const onTitleChange = (value: string) => {
    setTitle(value);
    if (editing === null && !slugEdited) setSlug(slugifySpecTitle(value));
    if (editing === null && !contentEdited) setContent(defaultSpecContent(value));
  };

  const save = async () => {
    const parsedSlug = editing ? editing.slug : parseSpecSlugOrNull(slug);
    if (parsedSlug === null) return;
    setSaving(true);
    setError(null);
    const outcome = editing
      ? await runMutation(environmentId, {
          action: "update",
          projectId,
          slug: parsedSlug,
          expectedRevision: makeSpecRevision(editing.revision),
          content,
          title: title.trim(),
        })
      : await runMutation(environmentId, {
          action: "create",
          projectId,
          slug: parsedSlug,
          expectedRevision: makeSpecRevision(0),
          content,
          title: title.trim(),
          ...(supersedesSlug ? { supersedes: supersedesSlug } : {}),
        });
    setSaving(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    onSaved(outcome.document);
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
          <DialogTitle>{editing ? "Edit spec" : "New spec"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-title">Title</Label>
              <Input
                id="spec-title"
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="What are we building?"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-slug">Slug</Label>
              <Input
                id="spec-slug"
                font="mono"
                value={effectiveSlug}
                disabled={editing !== null}
                aria-invalid={slugInvalid || undefined}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value);
                }}
              />
              {slugInvalid ? (
                <p className="text-xs text-destructive-foreground">
                  Use lowercase letters, numbers and single hyphens, up to 80 characters.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-content">Requirements (Markdown)</Label>
              <Textarea
                id="spec-content"
                value={content}
                onChange={(event) => {
                  setContentEdited(true);
                  setContent(event.target.value);
                }}
              />
            </div>
            {editing === null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="spec-supersedes">Supersedes (optional)</Label>
                <Input
                  id="spec-supersedes"
                  font="mono"
                  value={supersedes}
                  aria-invalid={supersedesInvalid || undefined}
                  onChange={(event) => setSupersedes(event.target.value)}
                  placeholder="slug of an older spec"
                />
              </div>
            ) : null}
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
            {saving ? "Saving" : editing ? "Save" : "Create spec"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

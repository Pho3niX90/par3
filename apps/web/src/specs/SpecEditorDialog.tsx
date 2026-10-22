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
import { seedSpecContent } from "./specs.logic";
import {
  isValidSpecSlug,
  makeSpecRevision,
  parseSpecSlugOrNull,
  slugifySpecTitle,
  useRunSpecMutation,
  useSpecsData,
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
  // A new spec follows the checkout's layout, which the specs query reports.
  const checkout = useSpecsData(
    environmentId,
    { projectId, limit: 1, includeTemplate: true },
    editing === null,
  ).data;
  const layout = checkout?.layout ?? "par3";
  const [title, setTitle] = useState(editing?.title ?? "");
  // Until edited, the slug and content follow the title and the checkout's template.
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const [typedContent, setTypedContent] = useState<string | null>(null);
  const [supersedes, setSupersedes] = useState(editing?.supersedes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = typedSlug ?? slugifySpecTitle(title, layout);
  const content = typedContent ?? editing?.content ?? seedSpecContent(title, checkout?.template);
  const effectiveSlug = editing ? editing.slug : slug;
  const slugInvalid = editing === null && slug.length > 0 && !isValidSpecSlug(slug, layout);
  const supersedesSlug =
    supersedes.trim().length > 0 ? parseSpecSlugOrNull(supersedes, layout) : null;
  const supersedesInvalid = supersedes.trim().length > 0 && supersedesSlug === null;
  const canSave =
    !saving &&
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    (editing !== null || isValidSpecSlug(slug, layout)) &&
    !supersedesInvalid;

  const save = async () => {
    const parsedSlug = editing ? editing.slug : parseSpecSlugOrNull(slug, layout);
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
                onChange={(event) => setTitle(event.target.value)}
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
                onChange={(event) => setTypedSlug(event.target.value)}
              />
              {slugInvalid ? (
                <p className="text-xs text-destructive-foreground">
                  {layout === "base"
                    ? "Use a name like PROJ-123_short-kebab, or lowercase letters, numbers and single hyphens, up to 80 characters."
                    : "Use lowercase letters, numbers and single hyphens, up to 80 characters."}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-content">Requirements (Markdown)</Label>
              <Textarea
                id="spec-content"
                value={content}
                onChange={(event) => setTypedContent(event.target.value)}
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

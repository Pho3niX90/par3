# Spec mode

Spec mode puts a reviewed requirements document between a request and the code. An agent drafts the spec, a person approves it, and only then can agents implement and verify it. Approval is enforced by the server, not by the prompt.

## Start a spec

Spec mode is on by default in every project. The composer offers **Spec** next to Build and Plan, plus the `/spec` command, and each project has a **Specs** list. A thread follows the spec workflow only after you bind it to a spec, so other threads are unaffected.

To hide it for a project, open the project's Settings and turn off **Spec mode**. That hides the ways to start new spec work. Existing specs stay readable and reviewable, and threads already bound to a spec keep their restrictions.

## The workflow

1. **Requirements.** Choose Spec in the composer and pick or create a spec. The thread's agent drafts `specs/<slug>/spec.md` with numbered acceptance criteria (`AC-1`, `AC-2`, …), fixes the readiness findings, and submits it for review. It cannot edit other files.
2. **Review.** Open the spec from the Specs list. Check the checkout path shown at the top, since approval covers the files in that checkout. Approve, request changes, or reject.
3. **Implementation.** Approving does not start anything. Choose **Start implementation** to create a thread bound to the spec. Its agent breaks the work into tasks that cover every acceptance criterion and reports progress.
4. **Verification.** A test agent records evidence for each criterion. Manual checks need a person to confirm them in the spec's Evidence tab. The spec is done only when every criterion has current, passing evidence.

Pushing a branch or opening a pull request is optional.

## Things to know

- **Changing approved requirements revokes approval.** If `spec.md` (or `specs/constitution.md`, in projects that have one) changes after approval, linked agents are stopped and can't continue until someone approves again. Updating tasks or evidence does not affect approval.
- **Approval belongs to one checkout.** A spec copied into another worktree or onto another machine arrives unapproved and needs its own review there.
- **Status files are owned by Par3** (except in [BASE projects](#base-projects)). `status.json`, `tasks.json` and `approval.json` are written by the server so they can be reviewed in git. Editing them by hand doesn't grant approval; the spec shows an error until you choose **Reopen**.
- **Criterion IDs are permanent.** Retire a criterion by striking it through (`~~AC-3~~`) instead of deleting or renumbering it. A criterion can be a plain list item or a checkbox item (`- [ ] AC-3: …`); ticking the box does not retire it.
- **Leaving Spec mode** on a thread is a deliberate action in the thread's spec banner. It is refused while the thread is running.

## BASE projects

If the project's root has a `.base` file, Par3 treats its specs as BASE specs. The choice is made when a spec is first created or found, and the spec keeps it.

- **Folders.** Specs live in `specs/KEY-123_short-name/` (or `specs/2026-short-name/`) as well as the usual lowercase names.
- **Template.** The sections a spec must have are the `##` headings in the project's `specs/_template.md`, and new specs start from that file. Extra sections never block review. Without a template, a spec only needs acceptance criteria. An unticked open question marked `[HIGH]` blocks review until it is resolved (ticked).
- **BASE's own files.** Par3 owns `spec.md` and the status line in it. It doesn't check `status.json`, `tasks.json` or `approval.json`, and writes them only when you approve a spec (below). Tasks and evidence are tracked by Par3 itself, and there is no constitution.
- **Approving.** Approving in Par3 records the approval the way the BASE extension does. A new entry is added to `approval.json` (who approved, when, and a hash of `spec.md` and the test plan), `spec.md` and `test-plan.json` are marked approved, `status.json` is stamped, and the spec's row in `specs/_status.md` is set to approved. A spec can be approved only while its frontmatter, `status.json` and `_status.md` row all say it is under review, and if any of these files changes while the approval is being recorded, nothing is written and you can try again. The approver is the checkout's git identity.
- **Approvals made in the extension.** An approval recorded by the BASE extension counts in Par3 for as long as `spec.md` is unchanged since. If the spec says approved but `approval.json` has no matching record, Par3 reports an error instead of treating it as approved; reopen the spec and approve it again.
- **Validators.** Par3 runs the project's validators (`validate_spec.py`, and the status validator when the project has one) before a spec goes to review or is approved, and refuses while they report errors. They need Python on the machine running Par3; without it Par3 says so and carries on. Agents can run the same checks with `spec_validate`.
- **BASE files.** Agents can write `prd.md`, `tech-analysis.md` and `status.json` next to `spec.md`, including while the requirements are still being drafted. Approval and task files are never written this way.
- **Status in the frontmatter.** When Par3 changes a spec's status, it updates the `status:` line in the spec's frontmatter, leaves the rest of the line, including any comment, alone, and updates the spec's row in `specs/_status.md` if the project keeps one. Changing only that line, or the `updated:` line, is not a requirements change and doesn't revoke approval. If someone edits it to a status the spec can move to without a person's approval (for example, from draft to review once the spec is ready), Par3 follows. It never treats an edited `approved` as an approval.

## Provider support

Writing requirements, research and read-only review need a provider Par3 can restrict to read-only tools: **Codex** or **Claude**. Implementation and testing work with every provider. If the thread's provider can't run the chosen role, Par3 explains why and asks you to pick another model.

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

- **Changing approved requirements revokes approval.** If `spec.md` or `specs/constitution.md` changes after approval, linked agents are stopped and can't continue until someone approves again. Updating tasks or evidence does not affect approval.
- **Approval belongs to one checkout.** A spec copied into another worktree or onto another machine arrives unapproved and needs its own review there.
- **Status files are owned by Par3.** `status.json`, `tasks.json` and `approval.json` are written by the server so they can be reviewed in git. Editing them by hand doesn't grant approval; the spec shows an error until you choose **Reopen**.
- **Criterion IDs are permanent.** Retire a criterion by striking it through (`~~AC-3~~`) instead of deleting or renumbering it.
- **Leaving Spec mode** on a thread is a deliberate action in the thread's spec banner. It is refused while the thread is running.

## Provider support

Writing requirements, research and read-only review need a provider Par3 can restrict to read-only tools: **Codex**, **Claude** or **GitHub Copilot**. Implementation and testing work with every provider. If the thread's provider can't run the chosen role, Par3 explains why and asks you to pick another model.

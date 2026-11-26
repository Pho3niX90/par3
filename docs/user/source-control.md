# Source control

Par3 integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin, and Linear to clone/publish repos, review and merge pull requests, manage issues, and watch CI.

## Connect an account

Install Git and authenticate on the machine running your Par3 server (for remote environments, do this on the remote machine), then click **Rescan** in **Settings → Source control & issues**.

| Host                               | Setup                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                         | 1) Save a token in **Settings → Source control & issues → GitHub**, 2) set `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` + `GH_HOST` for Enterprise), or 3) sign in with [GitHub CLI](https://cli.github.com/) 2.81.0+ (`gh auth login`; use `--hostname` for Enterprise). Pick accounts or disable hosts in Settings when multiple `gh` logins exist.                                                                                |
| **GitLab**                         | Install [GitLab CLI](https://gitlab.com/gitlab-org/cli) and run `glab auth login`.                                                                                                                                                                                                                                                                                                                                        |
| **Forgejo / Gitea**                | Install [`fj`](https://codeberg.org/forgejo-contrib/forgejo-cli) (`fj --host https://your-server auth add-token`) or [`tea`](https://gitea.com/gitea/tea) 0.16+ (`tea login add`). Prefers `fj`, falls back to `tea` (use `tea` for subpath-hosted servers). Use full URLs when multiple servers exist.                                                                                                                   |
| **Bitbucket**                      | Save a repo/project/workspace **Access token** or **Atlassian email + API token** (with repo/PR read-write, `read:user:bitbucket`, `read:workspace:bitbucket`) in **Settings → Source control & issues → Bitbucket**, or set `T3CODE_BITBUCKET_ACCESS_TOKEN` / `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN` in the server env (or [`service.env`](./background-service.md#configure-the-service-environment)). |
| **Azure DevOps**                   | Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), run `az extension add --name azure-devops`, then `az login`.                                                                                                                                                                                                                                                                                           |
| **GitCafe**                        | Save a token in Settings, set `CAFE_TOKEN` (+ `CAFE_HOST`), or install `@gitcafe/cli` and run `cafe auth login --host https://git.cafe/api`. Line comments are not yet supported; stack merges/updates are native.                                                                                                                                                                                                        |
| **Cursor Origin**                  | Install [Origin CLI](https://cursor.com/docs/origin/cli) and run `origin auth login` (`origin auth setup-git` if push prompts for credentials). Uses private HTTPS repos; GitHub-mirrored PRs stay on GitHub.                                                                                                                                                                                                             |
| **TanStack Source** (private beta) | Set `T3CODE_FEATURE_FLAGS=tanstack_source` and restart the server. Save a token in Settings, set `SRC_TOKEN`, or run `src auth login --web`. Supports live CI logs, private PRs on public repos, and issues.                                                                                                                                                                                                              |

> Note: Git `push` and `clone` still require Git SSH/HTTPS credentials on the server, separate from API tokens.

## Start, clone, or publish a project

- **New project**: Run **New project** from the command palette (`Cmd/Ctrl+K`) or **Add Project** to initialize a new Git repo in `~/.t3/projects/<slug>` with a README, icon, and first commit (optionally creating a private GitHub repo).
- **Clone**: Use **Add Project** to pick a host (enable non-GitHub hosts in **Settings → Source control & issues**) or paste a Git URL or web page URL. Cloning runs in the background so you can draft your first prompt immediately; falls back to HTTPS if SSH auth fails. Enable **Clone into host folders** (**Settings → Threads**, or **Source control** on mobile) for `ghq`-style `<host>/<owner>/<repo>` paths.
- **Publish**: For a local repo without a remote, **Publish Repository** creates the remote, adds `origin`, and pushes commits.
- **Folders of several repositories**: Par3 identifies such a folder by the repositories inside it, so the same set of repositories on another machine is the same project for grouping, load balancing, and delegation, whatever the folder is called. To make that explicit when some are not cloned yet, list them under `repositories` in a `par3.json` at the root of the folder, each with a `path` and a `url`.
- **Add to another machine**: Clones a project onto another connected machine and offers to copy the local files Git ignores, such as `.env`. A folder of several repositories clones each of them into the new folder and writes a `par3.json` listing them, and ignored files are offered per repository. If one repository fails, retry resumes from it and keeps the ones already cloned.

## Review turn changes

A turn's diff shows only that turn's own edits, commits, and conflict fixes—excluding unrelated files brought in by a pull, merge, or rebase. Use the branch comparison to view everything changed against your base branch.

- **Commits view** (web/desktop): Switch the Diff pane source picker to **Commits** to inspect the latest 100 local commits one by one.
- **Commit links**: Links to local commits open in the Diff pane (follows **Settings → Diffs → Open pull requests in Par3**; `Cmd/Ctrl+Click` opens in browser).
- **Multi-repo projects**: Use the repository picker in the Diff pane and expand per-repo rows in thread details. See [Projects with several repositories](./multi-repo-projects.md).

## Create, review, and merge pull requests

- **Create**: Commit, push, and open PRs from a thread's Git actions. Configure AI-generated commit/PR writing style in **Settings → Source control & issues → Commits & pull requests** (**Repository conventions** or **Custom instructions**).
- **Review**: Open **Pull requests** to inspect diffs, comments, checks, commits, and request reviewers. Draft line comments stay local until submitted. If new commits are pushed while you review, click **Load new commits** before merging or submitting.
- **Saved views**: Save and update filter/sort setups under **Views → Save current view** (stored per device).
- **Mark files viewed**: Check off files in the **Code** tab to collapse them (reopens as **Changed** on new pushes). Syncs natively with GitHub; stored on your Par3 server for other hosts.
- **Mobile**: Open **Pull requests** across environments (cached lists, details, guides, and diffs stay readable offline). Tap **Work on PR** to start a worktree thread on the PR's branch.
- **Quick actions & options**:
  - Enable **Remove agent credits when merging** in **Settings → Source control & issues** to strip recognized agent co-author/generated-by trailers on GitHub merge/squash commits (keeps human co-authors).
  - Hold `Shift` in the GitHub PR list (web/desktop) to drag-close multiple PRs (`Esc` cancels).
  - GitHub, GitLab, and Azure DevOps support auto-merge; GitHub also supports approving fork workflows and opening revert PRs.
  - Azure DevOps comments must be edited on the host site; Bitbucket cannot reopen declined PRs.

### Review guides (beta)

Turn on **Settings → Source control & issues → Review guides** to add a **Guide** tab to pull requests. Click **Write guide** to have Claude or Codex read the PR in a temporary read-only checkout and produce an ordered tour of the change (highlighting **Look closely** spots and grouping mechanical changes at the end).

- Customize emphasis/ordering via **Review guide instructions** in **Settings → Source control & issues** (project-overridable).
- On web, select lines in any stop to add review comments or ask an agent about that stop.
- Agents can also generate guides for multiple PRs when asked. Choose **Rewrite guide** from the PR's **⋯** menu after new pushes.

### Pull request sharing across environments

Disabled by default. In **Settings → Environments → Pull request sharing** (**Pull request routing** on mobile), opt in trusted environments to **Read PRs** or **Read and act** so review reads/actions can route through another connected environment signed into the same account on the same host (credentials never leave their machines). Enable on both source and target environments; only grant **Read and act** to environments you control.

## Linked pull requests and watching

Threads can link multiple PRs (even across repos on the same host). Creating a PR via Git actions, `gh pr create`, `glab mr create`, or an agent's `link_pull_request` links it automatically; manage links from **Linked items** or the command palette.

- **Agent PR tools**: Agents can read, open, update, comment on, and merge PRs in the thread's repo using your configured sign-in (refusing merges if the head moved since last read).
- **Watch / babysit a PR**: Ask an agent to watch or babysit a PR (or toggle it in **Linked items** / click the eye icon in thread details). The server polls every 2 minutes and wakes the agent on failed checks, passed required checks, new comments/reviews from others, conflicts, merge-queue drops, or merge/close.
  - Watched threads stay in the **Working** section while checks run (or until merge/close if the agent is waiting to act) and never auto-settle.
  - Watching stops automatically on merge/close, Stop, settle/archive, 10 comment-only wakes in a row, or 8 consecutive read failures. Subagents cannot watch PRs—the parent thread watches instead.

## GitHub stacks

The Pull requests page displays stack layer positions and navigation:

- **Merge stack**: Merges the selected PR and every open layer below it together, respecting branch rules and merge queues.
- **Rebase stack**: Updates remote branches bottom-to-top without modifying your local checkout (may rewrite history and restart checks).

## Resolving merge conflicts

When a merge, rebase, cherry-pick, or revert stops on conflicts, Par3 notices it whoever started it (you, an agent, or a terminal). The thread header shows the number of conflicts, and the Git action becomes **Resolve conflicts**. It opens the **Conflicts** panel, which lists each conflicted file for the thread's repository (one section per repository when a thread works in several).

- **Update from base** (web and desktop): On a conflicting pull request, merges the base branch into the pull request's branch on your machine, using the thread's own checkout when it is already on the branch and checking the pull request out first otherwise. A clean merge is left ready to push; conflicts open the panel. It needs a clean working tree, and **Resolve conflicts** still hands the work to an agent instead.
- **Per file**: Accept **ours** or **theirs**, or choose **Merge…** to open the three-pane view: ours on the left, theirs on the right, and the result in the middle. The result starts with every change only one side made already applied; real conflicts show the original text. Use the arrows between the panes to take a side, ignore it, or take both in either order, and edit the result freely. Undo reverses a choice together with its text. **F7** and **Shift+F7** move between conflicts. **Apply** saves the file and moves to the next one, and asks first if conflicts remain. If the file changed while it was open, Par3 asks you to reload it.
- **Resolve simple conflicts**: Merges each conflict again word by word and settles the ones where the two sides changed different words; it leaves real conflicts alone. **Ask agent** sends the list of conflicted files to the thread's agent, which resolves and stages them but does not continue or abort. Agents can also check and resolve simple conflicts themselves.
- **Rebases swap the sides**: **ours** is the branch you are rebasing onto and **theirs** is your commit being replayed. The labels above each pane name the branch or commit, so read those rather than the words. Binary files, very large files, and files stored through Git LFS or another filter can only be resolved by taking one side.
- **Continue** finishes the operation once nothing is left to resolve; a rebase may stop again with conflicts from its next commit. **Abort** returns the repository to how it was before the operation. If it was started outside Par3, uncommitted edits that existed beforehand can be discarded, so check before confirming. Resolving is unavailable while an agent is working in the same repository.
- **Mobile**: Accept a side for each file, resolve simple conflicts, ask the agent, and continue or abort, but not merge a file by hand. Files are never downloaded to the phone.

## Issues

Open **Issues** from the sidebar utility row or **Open issues** in the command palette to browse, filter, search, save views, comment, edit, and transition issues across GitHub, GitLab, Azure DevOps, Forgejo, and Linear.

- **Linear**: Connect an API key in **Settings → Source control & issues** and bind one or more teams per project (supports multiple Linear accounts). Agents file new issues in the first bound team unless another is named.
- **Link to threads**: Click **Link to this thread** on an issue beside a thread (or let agents call `link_issue`) to track it in **Linked items**.
- Remote issue writes require the `source-control:write` scope.

### Jira issues

Set your Jira site in **Settings → Integrations → Jira** (on mobile, in the server's source control settings), for example `https://company.atlassian.net`. When a thread's branch name contains an issue key such as `feature/ABC-123-login`, the thread details card and the mobile Git overview show the issue under the branch. Click it to open the issue in Jira.

- **Summary and status**: Add an API token. For Jira Cloud, enter your account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). For Jira Server or Data Center, leave the email empty and enter a personal access token. The token stays on the server.
- **Project keys**: By default only uppercase keys in branch names count, so `ABC-123` works but `abc-123` does not. Add **Jira project keys** to match those projects in any case, and in pull request titles too. With project keys set, issue keys in chat messages also link to their issues, and the latest few issues the chat mentions appear under the branch too, or on their own in a project folder that is not a repository. Projects can set their own keys.
- **Plan files**: Markdown files in the workspace whose path names an issue, such as `docs/ABC-123-plan.md`, appear under that issue so you can open them from the thread details card. The list refreshes when a turn finishes. Files in folders Git ignores do not appear.

## Troubleshooting

- **Not authenticated**: Run the host's CLI login on the server and click **Rescan** (for Bitbucket/tokens, verify Settings or server env vars).
- **GitHub verification fails**: Upgrade `gh` to 2.81.0+ or save a token in Settings.
- **Push fails**: Check Git SSH/HTTPS credentials separately from API auth.
- **Fork PR badge missing**: Set upstream with `git branch --set-upstream-to=<remote>/<branch>`.

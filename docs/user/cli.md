# CLI reference (`par3`)

The `par3` command runs and manages Par3 servers, background services, remote access, threads, workflows, and diagnostics. Run `par3 --help` or `par3 <command> --help` for full flags.

See [Install Par3](./install.md#command-line) for installation (`curl -fsSL https://par3.paritylabs.co.za/install.sh | sh`, `irm https://par3.paritylabs.co.za/install.ps1 | iex`, or `npx par3-cli@latest`).

## Running and connecting

| Command                      | Description                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `par3 [path]` / `par3 start` | Start a foreground server and open the web app (optionally in a project directory).                                                  |
| `par3 serve`                 | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`).                         |
| `par3 app [path]`            | Open a directory as a project/thread in the running desktop app.                                                                     |
| `par3 up`                    | Interactive setup for remote access (Parity Connect and/or LAN) plus background service (`--connect`, `--lan`, `--no-lan`, `--yes`). |
| `par3 connect`               | Manage Parity Connect (`par3 connect`, `status`, `login`, `logout`, `link`, `unlink`).                                               |
| `par3 status`                | Show how other devices can reach this host (`--json`).                                                                               |
| `par3 pair`                  | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                                        |

## Background service and updates

| Command                           | Description                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `par3 service`                    | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `par3 update [version]`           | Update `par3` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                                  |
| `par3 install` / `par3 uninstall` | Install or remove the `par3` launcher and background service (keeps `~/.t3/userdata`).                                                              |

## Threads, projects, and workflows

| Command         | Description                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `par3 thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-par3-thread). |
| `par3 project`  | Manage projects on the host (e.g. `par3 project add <path> --track <folder>`).                                                                                                                                  |
| `par3 workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                          |

## Environments, auth, themes, and policy

| Command            | Description                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `par3 environment` | Link or manage peer environments (`par3 environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).                                  |
| `par3 auth`        | Manage pairing codes, sessions, and Parity Connect device approvals (`pairing create`, `session list/revoke/issue`, `connect-device list/approve/revoke`). |
| `par3 theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                                        |
| `par3 policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).                  |

## Diagnostics and maintenance

| Command              | Description                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `par3 doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `par3 browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `par3 trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `par3 triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the Par3 triage playbook.                  |
| `par3 feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |

# Install Par3

Par3 runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install Par3 on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch Par3 first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Install the `par3` command, and `p3` as a shorter alias, to `~/.local/bin`:

```bash
# macOS / Linux
curl -fsSL https://par3.paritylabs.co.za/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://par3.paritylabs.co.za/install.ps1 | iex
```

Set `T3CODE_CHANNEL=nightly` for nightly builds or `T3CODE_VERSION=<ver>` to pin a version. To try once without installing, run `npx par3-cli@latest` (requires Node.js; always runs the latest stable release).

| Task                          | Command                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| Start server and open web app | `par3` (or `par3 ./my-project`)                                           |
| Start server without browser  | `par3 serve`                                                              |
| Set up remote access          | `par3 up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `par3 service install` ([Background service](./background-service.md))    |
| Update                        | `par3 update`                                                             |
| Reclaim database space        | `par3 doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `par3 uninstall`                                                          |

If `par3` reports a server is already running, connect with `par3 pair` or pass a separate `--base-dir`. Run `par3 --help` for all commands.

### Intel Macs

There is no standalone `par3` binary for Intel Macs—use the desktop app, or build a server from source with `vp` ([development runbook](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/Pho3niX90/par3
cd par3 && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

## Desktop app

Download a release from [GitHub Releases](https://github.com/Pho3niX90/par3/releases).

- **Debian / Ubuntu**: `sudo apt install ./Par3-*.deb`. `.deb` self-updates with a password prompt.
- **Linux AppImage**: `chmod +x ./Par3.AppImage && ./Par3.AppImage` (x86_64 and ARM64; use the exact filename you downloaded).

### The `par3` command

The desktop app bundles `par3` and sets it up on first launch (manage anytime under **Settings → About → par3 command**; on macOS and Linux it adds `par3` and `p3` links in `~/.local/bin` or `~/bin`). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `par3 app` (or `par3 app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install provider CLIs inside that distro). Par3 manages its own server runtime inside WSL automatically.

## Mobile app

Install from [Google Play](https://play.google.com/store/apps/details?id=com.paritylabs.par3); there is no iPhone or iPad app in the App Store yet (QR codes are also in **Settings → About → Mobile app**). The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- The store app works with both Stable and Nightly servers. To try test builds, download and install the APK from the [Android beta release](https://github.com/Pho3niX90/par3/releases/tag/android-nightly).
- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider           | Install and authenticate                                                                                                         | Guide                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Codex**          | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.         | [Codex](./providers-codex.md)             |
| **Claude**         | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                                       | [Claude](./providers-claude.md)           |
| **Cursor**         | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                                       | [Cursor](./cursor.md)                     |
| **Grok Build**     | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                                 | [Grok](./providers-grok.md)               |
| **GitHub Copilot** | Install [GitHub Copilot CLI](./providers-copilot.md#set-up-github-copilot) (`npm i -g @github/copilot`) and run `copilot login`. | [GitHub Copilot](./providers-copilot.md)  |
| **Antigravity**    | Install managed runtime and sign in with Google in Settings.                                                                     | [Antigravity](./providers-antigravity.md) |
| **OpenCode**       | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                           | [OpenCode](./providers-opencode.md)       |
| **Kiro**           | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                         | [Kiro](./providers-kiro.md)               |
| **Pi**             | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                        | [Pi](./providers-pi.md)                   |
| **Muse Code**      | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                                    | [Muse Code](./providers-muse.md)          |
| **fx**             | Install [fx](https://fx.sh) and run `fx login`.                                                                                  | [fx](./providers-fx.md)                   |
| **ACP Registry**   | Add other ACP agents in **Settings → Providers → Add provider → Show more**.                                                     | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during Par3's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 par3 serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how Par3 works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating Par3](./updating.md): keep apps, servers, and providers up to date.

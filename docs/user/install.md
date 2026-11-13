# Install Par3

Par3 runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Par3 and configure providers afterwards.

## Command line

```bash
curl -fsSL https://par3.paritylabs.co.za/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://par3.paritylabs.co.za/install.ps1 | iex
```

This installs the `par3` command, and `p3` as a shorter alias, to `~/.local/bin`.
If that folder is not on your `PATH` yet, the installer says so and, for zsh,
bash on Linux, and fish, prints a command to add it. On Windows, `par3` works in
the same PowerShell window right away; add the folder to your `PATH` for new
windows. If a `par3` that the installer or the desktop app did not create is
already there, it leaves that one alone and stops. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                  | Command                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Start the server and open the web app | `par3`                                                                    |
| Start the server without a browser    | `par3 serve`                                                              |
| Use it from your other devices        | `par3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `par3 service install` ([details](./background-service.md))               |
| Move to the newest release            | `par3 update`                                                             |
| Reclaim database space                | `par3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `par3 uninstall`                                                          |

Run `par3 help` or `par3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `par3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `par3` or `par3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

To try Par3 once without installing it, run `npx par3-cli@latest` instead (needs
Node.js for `npx`). It offers to install the `par3` command first. If you say no,
it asks again at the next minor release, and `npx par3-cli install` installs it
later. `npx par3-cli` always runs the version npm picked, even when a `par3` is
installed. On the nightly train, run your installed `par3` (for example
`par3 connect`), not `npx par3-cli`, which runs the latest stable release.

### Intel Macs

There is no `par3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](../operations/development.md#first-checkout)):

```bash
git clone https://github.com/Pho3niX90/par3
cd par3 && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`par3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/Pho3niX90/par3/releases).
On Debian or Ubuntu, install the `.deb` with `sudo apt install ./Par3-*.deb`.

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`Par3.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./Par3.AppImage
./Par3.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `par3` command

The desktop app includes the `par3` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**par3 command** in **Settings → About**. On macOS and Linux it adds `par3` and
`p3` links in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command
folder to your `PATH`. Open a new terminal afterwards. If the folder is not on
your `PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds
one line to your shell's startup file. **Remove** takes it off, and the app does
not add it again. If you already have another `par3`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. Par3 installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
par3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `par3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `par3 app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

On Android, install Par3 from
[Google Play](https://play.google.com/store/apps/details?id=com.paritylabs.par3). There is no
iPhone or iPad app in the App Store yet. The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through Parity Connect or a pairing URL.

The store link and QR code are also available in **Settings → About → Mobile app**
on web and desktop. The store app works with both stable and Nightly servers. To try test builds,
download and install the APK from the
[Android beta release](https://github.com/Pho3niX90/par3/releases/tag/android-nightly).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider       | Install and authenticate                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude         | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor         | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build     | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| GitHub Copilot | Install [GitHub Copilot CLI](./providers-copilot.md#set-up-github-copilot) (`npm i -g @github/copilot`), then run `copilot login`.                        |
| Kiro           | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode       | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity    | Install and sign in with Google from Par3's provider settings.                                                                                            |
| Pi             | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code      | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx             | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Par3 cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Par3 warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Par3 cannot tell. Claude, Codex, and
OpenCode installs Par3 cannot identify stay manual: update them through the
installer you used. Par3 runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with Par3. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Par3 tested. When Par3 finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Par3 does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but Par3 reports a timeout while checking it,
allow more time in the Par3 server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 par3 serve
```

For a remote environment, set these on the machine running the Par3 server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating Par3](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Par3 for everyone on a machine.

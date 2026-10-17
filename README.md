# Par3

Par3 is an "agent harness control surface" for teams. It lets you control the coding agents on your machines from a desktop app, a web app and a mobile app.

Works with your subscriptions on Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Par3 can control them.

## Why Par3 exists

Par3 is a fork of [T3 Code](https://github.com/pingdotgg/t3code), an excellent open-source project by T3 Tools. T3 Code is led directly by Theo, and its product decisions are his to make. That is a fair way to run a project, but some of those decisions don't fit how enterprise teams work.

The clearest example is plan mode. T3 Code removed it, while most engineers we work with, especially in enterprise, want to see and approve a plan before an agent touches their code. Par3 keeps plan mode as a first-class setting and makes product decisions around what enterprise teams need: reviewable plans, explicit permissions, and clear visibility into what agents do.

We still merge T3 Code's improvements regularly and are grateful for the work behind it. T3 Code is MIT licensed, and so is Par3.

## Installation

> [!WARNING]
> Par3 currently supports Codex, Claude, Cursor, GitHub Copilot, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - GitHub Copilot: install [GitHub Copilot CLI](https://github.com/github/copilot-cli) and run `copilot login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://par3.paritylabs.co.za/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://par3.paritylabs.co.za/install.ps1 | iex
```

Then run `par3` to start the server and open the local web app. `par3 service install` keeps it running in the background, `par3 update` moves to a newer release, and `par3 --help` has the full reference.

To try it once without installing, run `npx @paritylabs/par3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/Pho3niX90/par3/releases).

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/Pho3niX90/par3/releases), then:

```bash
sudo apt install ./Par3-*.deb
```

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Par3 as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Par3 uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

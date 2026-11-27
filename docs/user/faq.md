# FAQ

## Is Par3 a harness?

No. A harness turns an LLM into an agent (tools, execution loop, and results)—like Claude Code's Agent SDK or Codex App Server. Par3 drives those harnesses through one fast interface; it does not work without at least one installed agent.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, GitHub Copilot, Kiro, Pi, Muse Code, fx, or any [ACP agent](./providers-acp.md). See [Provider setup](./install.md#providers).

## Why use Par3 instead of Claude Code or the Codex app?

- **Bring your own subscription**: Use Claude, Codex, and every other agent you already have installed in one place.
- **Remote first**: Run `par3 up` on any machine and drive it from your desktop, browser, or phone.
- **Review before agents act**: Plan mode lets you see and approve a plan before an agent touches your code.
- **Open source (MIT)**: Based on T3 Code. Fork the source code under your own branding if you ever want something different.

## Can I use Par3 with my Claude Code subscription?

Yes.

## How much does Par3 cost?

Par3 is free and open source (MIT). You bring your own subscription and keep paying your provider as you do now. Parity Connect, the built-in way to reach your machines remotely, links up to 3 host machines per account (phones and browsers don't count). For more, pair over your network or Tailscale. See [Remote access](./remote-access.md).

## Can I fork or redistribute Par3?

Yes, for the source code. The [MIT License](../../LICENSE) covers source code only—not upstream T3 Tools, Inc.'s trademarks, branding, or trade dress. If you publish a fork or custom build, use your own branding and make it clear that your project is unofficial. See [TRADEMARK.md](../../TRADEMARK.md).

## Why is my Claude 5-hour limit draining so fast?

It shouldn't anymore: Claude in Par3 now drains your 5-hour limit at the same rate as Claude Code directly (an earlier Anthropic Agent SDK discrepancy has been resolved). If you still see it, [update Par3](./updating.md) on the machine running your agents.

## How do I use Par3 remotely?

Your agents run wherever the Par3 server runs (desktop, server, or VPS). Run `par3 up` on that machine and connect via Parity Connect, LAN, Tailscale, or [app.paritylabs.co.za](https://app.paritylabs.co.za). See [Remote access](./remote-access.md).

## How do I use Par3 on my phone?

Install the [Android app](https://play.google.com/store/apps/details?id=com.paritylabs.par3) and connect it to your computer with Parity Connect or a pairing link. There is no iPhone or iPad app in the App Store yet. The phone is a remote control—your host computer runs the agents and must stay on. See [Mobile app](./install.md#mobile-app) and [Remote access](./remote-access.md).

## Why does Parity Connect keep disconnecting?

Open **Settings → Environments**, select the machine, and choose **Details**—the first failed check identifies the cause. See [Parity Connect troubleshooting](./t3-connect-troubleshooting.md). Tailscale also makes a good direct fallback.

## Will I get banned for using my subscription?

Par3 runs each provider through its own official CLI, SDK, or ACP integration, signed in with your account, the same way you would use it directly. Your provider's terms still apply, so check them if you are unsure.

## Can I add a bunch of accounts for one provider?

Par3 does not switch between accounts for you; automatic switching risks breaking providers' terms. Adding a separate work/personal account is supported ([Codex](./providers-codex.md#use-multiple-accounts), [Claude](./providers-claude.md#multiple-accounts-and-presets)). For larger pools managed externally (e.g. via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)), Par3 can display pooled limits under Usage ([Connect a hub](./usage.md#connect-a-cliproxyapi-hub)).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables and endpoint (your subscription setup stays untouched). See [OpenRouter for Claude](./providers-claude.md#openrouter-and-local-routers) and [Providers](./install.md#providers).

## Does Par3 support local models?

No. Par3 runs coding-agent providers and does not run models itself.

## Does my code go to Parity Labs' servers?

No. Code and prompts go directly from your machine to your chosen provider. With Parity Connect, traffic travels over a Cloudflare tunnel (`cloudflared` on your machine); the relay coordinates the link without proxying your HTTP/WebSocket sessions.

Product usage data is off by default. If you turn on **Send usage data** in **Settings → Telemetry**, Par3 sends basic product usage events (provider, model, token totals; no prompts or file contents). `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` keeps it off whatever the switch says. See [Product usage data](./telemetry.md).

## Worktrees are eating my disk. How do I clean them up?

Enable automatic cleanup or run **Delete now** in **Settings → Worktrees → Cleanup**. See [Storage cleanup](./project-settings.md#storage-cleanup).

## Is there voice input?

Yes—on-device speech on Android and macOS 26+ desktop, or via a paired environment on web/desktop/mobile. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three (desktop app and CLI). Note: there is no standalone `par3` binary for Intel Macs (use the desktop app there), and Windows users can also run agents inside WSL. See [Install](./install.md).

## Why is my provider not showing up?

Usually the provider CLI is not installed, not signed in, or not on the `PATH` of the **server machine** (especially with version managers). Authenticate on the server machine first (e.g. `codex login` or `claude auth login`) and set **Binary path** in **Settings → Providers** if needed.

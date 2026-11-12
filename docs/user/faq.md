# FAQ

## Is Par3 a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. Par3 uses those harnesses. It is not a harness, and it does not work without one.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, GitHub Copilot, Kiro, Pi, or Muse Code. [Provider setup](./install.md#providers)

## Why use Par3 instead of Claude Code or the Codex app?

- Bring your own subscription. Claude, Codex, and whatever else you already have installed.
- Remote first. Run `par3 up` on any machine and drive it from your desktop, browser, or phone.
- Review before agents act. Plan mode lets you see and approve a plan before an agent touches your code.
- Open source (MIT), based on T3 Code.

[Install](./install.md)

## Can I use Par3 with my Claude Code subscription?

Yes.

## How much does Par3 cost?

Par3 is free and open source (MIT). You bring your own subscription and keep paying your provider as you do now. Parity Connect, the built-in way to reach your machines remotely, links up to 3 machines per account; phones and browsers do not count. For more, pair over your network or Tailscale. [Remote access](./remote-access.md)

## Why is my Claude 5-hour limit draining so fast?

Par3 drives Claude through Anthropic's Agent SDK. Agent SDK usage has been reported to drain the 5-hour limit faster than using Claude Code directly. Weekly limits are not affected.

## How do I use Par3 remotely?

Your agents run wherever Par3 runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `par3 up` on that machine. Parity Connect is the easiest path; LAN pairing and Tailscale work too, and [app.paritylabs.co.za](https://app.paritylabs.co.za) is the web client. [Remote access](./remote-access.md)

## How do I use Par3 on my phone?

Install the [Android app](https://play.google.com/store/apps/details?id=com.paritylabs.par3), then connect it to your computer with Parity Connect or a pairing link. There is no iPhone or iPad app in the App Store yet. The phone is a remote: your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does Parity Connect keep disconnecting?

Parity Connect is the built-in alternative to Tailscale for remote connections. If it keeps dropping, open **Settings > Environments**, find the machine, and select **Details**. The first part marked as failed is the cause. Tailscale makes a good fallback. [Parity Connect troubleshooting](./t3-connect-troubleshooting.md)

## Will I get banned for using my subscription?

Par3 runs each provider through its own official CLI, SDK, or ACP integration, signed in with your account, the same way you would use it directly. Your provider's terms still apply, so check them if you are unsure.

## Can I add a bunch of accounts for one provider?

Par3 does not switch between accounts for you; automatic switching risks breaking providers' terms.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Par3 with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). After you set up a hub, Par3 can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Par3 support local models?

No. Par3 runs coding-agent providers and does not run models itself.

## Does my code go to Parity Labs' servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. With Parity Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine). The relay sets up the link. It does not proxy your HTTP or WebSocket sessions. Par3 does send basic product usage events (provider, model, token totals, and similar). No prompts, no file contents. That is the same on Tailscale, LAN, or Parity Connect. Set `T3CODE_TELEMETRY_ENABLED=false` to turn it off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On Android, dictation uses on-device speech by default; you can opt in to a paired environment instead. Web and desktop require you to choose an environment first. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three: desktop app and CLI. There is no `par3` binary for Intel Macs, so use the desktop app there. On Windows you can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server (the computer, not your phone). Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers often cause this. [Provider setup](./install.md#providers)

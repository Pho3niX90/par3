# Product usage data and diagnostics

Product usage events and relay connection traces are off by default. Par3 sends them only after you turn them on, to help keep the app reliable and fast. Prompts, responses, file contents, and credentials are never included (unless you explicitly approve an [agent feedback](#agent-feedback) card with conversation text attached).

## Product usage events

When turned on, the server sends usage events to Par3's own PostHog project under a hashed random install ID (plus a hashed Parity Connect account ID when signed in, and random client device IDs). Events contain provider, catalog model name (non-catalog models report as custom), reasoning effort, permission mode, turn/request outcome, duration, release channel, and token counts.

## Turn telemetry on or off

- **Server, desktop app, and browsers opened from a server**: Turn on **Send usage data** in **Settings → Telemetry**. Each connected environment has its own switch. Turning it off stops sending immediately, without a restart.
- **Hosted web app**: Turn on **Send connection diagnostics from this device** in **Settings → Telemetry**.
- **Mobile app**: Turn on **Send crash reports** and **Send connection traces** separately in **Settings → About Par3 → Diagnostics**. Both stay off until you turn them on.
- **Environment variables (server / CLI)**: `T3CODE_TELEMETRY_ENABLED=true` turns telemetry on without the switch. `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` keeps it off whatever the switch says (`DO_NOT_TRACK=1` takes precedence). Settings shows when a variable is deciding. CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`) stay off unless `T3CODE_TELEMETRY_ENABLED=true`.
- **Environment variables (desktop app)**: Export them in your shell profile (macOS/Linux) or user environment variables (Windows) and restart.
- **Managed policy**: Administrators can set `"telemetry": false` in [managed policy](./managed-policy.md#other-capabilities) to keep it off for servers and desktop apps. A policy cannot turn it on.

## Relay connection diagnostics

When turned on, Parity Connect sends connection timings, request paths, environment/thread IDs, and error types (no addresses, logs, or stack frames) to Axiom. The switches, variables, and policy above control it, and it also stops with `T3CODE_OTEL_SDK_DISABLED` / `OTEL_SDK_DISABLED`. `T3CODE_OTEL_SDK_DISABLED` takes precedence over `OTEL_SDK_DISABLED`, so `T3CODE_OTEL_SDK_DISABLED=false` keeps relay diagnostics on even when `OTEL_SDK_DISABLED=true`.

## Agent feedback

Optional tool for agents to report Par3 bugs or missing capabilities. Configure in **Settings → Labs → Agent feedback**:

- **Off** (default): Feedback tools and `par3 feedback` are disabled.
- **When I ask**: Agents submit a report only when you ask, shown as an interactive approval card before anything leaves your machine.
- **Automatic**: Also sends minimal automated reports (problem kind + tool/command name only—no text or conversation) when an agent hits a Par3 tool failure; enables `par3 feedback` CLI reporting (up to 10/hour).

Approval cards show exact payloads (expected/actual/workaround, turn outline with no text, and optional **Include the conversation** up to 16 KB). File paths, usernames, hostnames, git remotes, and secret-like strings are scrubbed before saving, and reports use one-off random IDs. Inspect local reports with `par3 feedback list [--json]`.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the Parity Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).

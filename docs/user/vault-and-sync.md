# Vault and sync

Keep secrets, shared MCP servers, and agent instructions the same on every machine that runs
Par3. Edit a secret once and every machine and provider uses it; add an agent or rule on one
machine and the others pick it up.

## What syncs

Each machine chooses what it shares, in **Settings → Vault & sync**:

- **Vault secrets**: API keys and tokens.
- **Shared MCP servers** from **Settings → Integrations**.
- **Claude**: `CLAUDE.md` and `rules/`, `agents/`, `commands/`, and `skills/` in Claude's
  config folder.
- **Codex**: `AGENTS.md`, `prompts/`, and `skills/` in Codex's home.
- **OpenCode**: `AGENTS.md`, `agents/`, `commands/`, and `skills/` in `~/.config/opencode`.
- **Antigravity**: the two user skill folders in `~/.gemini` (`config/skills` and
  `antigravity-cli/skills`).
- **Cursor**: `skills/` in `~/.cursor`. Cursor keeps its user rules inside the app, so they
  can't sync.
- **Grok**: `AGENTS.md` and `skills/` in `~/.grok`.
- **Pi**: `AGENTS.md`, `prompts/`, and `skills/` in `~/.pi/agent`.
- **Copilot**: `copilot-instructions.md`, `instructions/`, `agents/`, and `skills/` in
  `~/.copilot`.
- **Shared agent files**: `skills/` and `commands/` in `~/.agents`, which several providers read.

Muse and agents from the ACP registry keep no global configuration in files, so there is
nothing to sync for them.

Nothing else in those folders syncs: settings files (such as `opencode.json`, `config.toml`, or
`settings.json`), credentials, plugins, and sessions stay on their machine. Only text files up to 1 MB sync; Par3 lists anything it skipped and why. A
provider with its own config folder set in its settings is not synced.

Sync runs while Par3 is connected to both machines, from any window or device. A machine that
was offline catches up the next time Par3 connects to it and another synced machine.

## Set it up

When Par3 first connects to a machine that can sync, it asks whether to sync it. The first
machine starts the set; later machines join it, and Par3 shows what would copy each way before
anything changes. You can untick categories or individual items, choose **Don't sync this
machine**, or decide later in **Settings → Vault & sync**. Machines you set up before updating
are asked the same way.

To stop, turn a category off or choose **Stop syncing this machine**. Files already copied stay.

## The vault

The first machine to use the vault creates it. To add another machine, choose **Join vault**:
Par3 shows that machine's key fingerprint, which must match the one in that machine's own
**Vault & sync** settings. Secret values never pass through the Par3 window or app you use;
machines exchange them encrypted with a key only vault machines hold. Anyone who can manage
access on a vault machine can add a machine to the vault.

Use a secret anywhere Par3 asks for a secret value, such as a provider's environment variables
or a shared MCP server's headers: choose **Use vault secret**, or type `vault:NAME`. Par3 fills
the value in on the machine itself, so the setting syncs without the secret in it. **Import
existing secrets** moves secrets you already saved in settings into the vault and replaces them
with references.

**Leave vault** on a machine deletes its vault key and secrets there. Settings that refer to
them stop working on that machine until it joins again.

### Agents and secrets

Agents use secrets by reference without seeing them. An agent can read a secret's value only if
you turn on **Agents may read** for that secret, and only in a thread with full access. Each
read, and each refused attempt, is listed under the secret.

## Conflicts

If the same item changed differently on two machines, or a machine joins with a different
version, nothing is overwritten. The item shows as a conflict in **Settings → Vault & sync**:
keep one machine's version, or delete it everywhere.

When a file exists in exactly two versions, **Merge…** opens both side by side with an editable
result in the middle, and **Apply** writes the result to every machine. Sync keeps no copy of the
version the machines last agreed on, so lines only one side has are offered as that side's change:
check whether each was added on one machine or removed on the other. Secrets and MCP servers
can't be merged.

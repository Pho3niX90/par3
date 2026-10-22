# GitHub Copilot

T3 Code runs GitHub Copilot through the Copilot CLI's ACP server (`copilot --acp`). It works with
GitHub.com, GitHub Enterprise Cloud with data residency (`*.ghe.com`), and GitHub Enterprise
Server. GitHub lists ACP support in the Copilot CLI as a public preview, so behavior may change
between CLI releases.

## Set up GitHub Copilot

1. Install the GitHub Copilot CLI on the machine running T3 Code:

   Using npm (Node.js 22+):

   ```sh
   npm install -g @github/copilot
   ```

   Or using Homebrew:

   ```sh
   brew install copilot-cli
   ```

2. Sign in:
   - **GitHub.com**: run `copilot login`.
   - **GitHub Enterprise**: run `copilot login --host <your-host>`, for example
     `copilot login --host https://company.ghe.com`.

3. Open T3 Code. GitHub Copilot is on by default, and once the CLI is found it leads the provider
   list, so new threads use it unless a project or thread picks another provider. Check it under
   **Settings > Providers**, and refresh the provider after installing the CLI.

## GitHub Enterprise

Set these under the GitHub Copilot provider settings:

- **Enterprise URI / Host**: your instance URL or hostname, such as `https://company.ghe.com` or
  `github.mycompany.com`. Leave it blank for GitHub.com.
- **Access token**: optional. Use a fine-grained personal access token with the **Copilot
  Requests** permission. Classic `ghp_` tokens are not supported. The token is stored in plain text
  on disk and takes priority over your `copilot login`. Leave it blank to use the CLI's own login.

## Use more than one account

Add a GitHub Copilot instance per account, for example one for GitHub.com and one for your
enterprise host. Each instance has its own host and token.

## Models

**Copilot Default** uses the model your Copilot CLI is configured with. The other models your plan
offers appear in the model picker once T3 Code has read them from Copilot. It does this once when it
first finds the CLI working, by briefly starting a Copilot session in an empty temporary folder
without signing in, and again from every thread you start. If you are not signed in to Copilot yet,
the list fills in after your first thread.

[Copilot Free and Student plans](https://docs.github.com/en/copilot/get-started/plans) support only
automatic model selection. On these plans, seeing only **Copilot Default** is expected: GitHub
chooses the model for each request. Individual paid plans can offer named models too; an enterprise
account is not required.

For plans that allow manual model selection, run `/model` in the Copilot CLI to check the IDs your
account offers. If an available model is missing from Par3, add its ID under **Custom models** in
the instance settings. Custom models do not unlock models excluded by your plan.

## Subagents and tools

- Subagents that Copilot starts with its `task` tool appear as child sessions in the thread.
- T3 Code's tools and the MCP servers configured for the thread are available to Copilot.

## Commit messages, branch names, and titles

GitHub Copilot can write commit messages, branch names, pull request text, and thread titles. T3 Code
uses it for these only when no earlier provider is available (Codex, Claude, Cursor, Grok, Muse, Pi,
OpenCode, or Antigravity), or when you choose a GitHub Copilot model for text generation in
**Settings**. Each request runs in a fresh Copilot session that cannot use tools.

Review guides that need the model to investigate your checkout are not supported on GitHub Copilot.
Choose another model for those.

## Usage

GitHub Copilot does not report how much of your allowance you have used, so T3 Code cannot draw
usage bars for it. Open **GitHub Copilot usage** from the usage panel to go to your Copilot settings
page on GitHub (`/settings/copilot/features` on your GitHub host), which shows the credits you have
used and your allowance. When a request hits a limit, the thread shows Limited.

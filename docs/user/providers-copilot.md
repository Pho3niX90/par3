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

3. In T3 Code, open **Settings > Providers**, enable **GitHub Copilot**, and refresh the provider.

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
offers appear in the model picker after your first GitHub Copilot thread starts, because T3 Code
reads them from the running session. They are not listed before then, and are lost on restart until
a thread starts again.

If a model is missing, add its ID under **Custom models** in the instance settings. Run `/model` in
the Copilot CLI to see the IDs your plan offers.

## Subagents and tools

- Subagents that Copilot starts with its `task` tool appear as child sessions in the thread.
- T3 Code's tools and the MCP servers configured for the thread are available to Copilot.

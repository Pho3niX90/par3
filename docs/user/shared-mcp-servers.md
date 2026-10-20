# Shared MCP servers

Add an MCP server once, and every agent in every thread on that environment can
use it, whichever provider runs the thread. Par3 connects to the server itself
and hands its tools to agents through Par3's own MCP server, so this works the
same over a local, remote or Parity Connect connection.

## Add a server

In **Settings → Integrations → Shared MCP servers**, choose **Add server**:

- **Name** is what agents use to reach the server, such as `linear`. Use
  lowercase letters, digits, `-` and `_`.
- **Description for agents** tells agents when the server is useful.
- **Command** runs a local server, for example `npx` with the arguments `-y`
  and `@modelcontextprotocol/server-everything`, one per line. The command runs
  on the environment's machine, not on the device you are using.
- **HTTP** connects to a remote server by URL. Add an `Authorization` header or
  other headers its provider asks for.

Mark tokens and keys as **Secret**. Secret values stay in the environment's
secret store and are never sent back to clients. Put tokens in a secret
environment variable or header, not in the arguments or the URL's query string,
which are stored and shown as plain text.

Choose **Test connection** from a server's menu to start it and list its tools.
Untick a tool to stop agents calling it. Turn a server off with its switch;
agents then see it as disabled.

### From the command line

On the environment's machine, `par3 mcp` adds, lists and removes servers, much
like `claude mcp add`. A running Par3 picks the change up without a restart.

```sh
par3 mcp add -e API_KEY=... everything -- npx -y @modelcontextprotocol/server-everything
par3 mcp add -H "Authorization: Bearer ..." -d "Linear issues" linear https://mcp.linear.app/mcp
par3 mcp list
par3 mcp remove linear
```

A URL makes an HTTP server; anything else is a command. Every `-e` and `-H`
value is stored as a secret. Use `--base-dir` to target an environment that
does not use the default Par3 home.

## Using it from a thread

Agents list the shared servers with `mcp_servers` and call a tool with
`mcp_call`. Each call shows in the thread as the server and tool it reached,
for example `linear · lookup`. A thread in plan mode can call only the tools a
server marks as read-only.

Par3 connects to a server the first time an agent uses it and disconnects it
after ten minutes unused. Only people who can change the environment's settings
can add or change servers. Agents cannot.

## Pick one place for each server

If a provider's own MCP config already lists a server, remove it there or don't
add it here. With both, the agent sees the same tools twice.

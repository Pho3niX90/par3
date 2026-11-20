import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  McpGatewayServerStatus,
  McpGatewayTestResult,
  McpServerConfig,
  McpServerHeader,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { MoreVertical, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { m as resolveNow, type MessageResolver } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useSyncViews } from "../../state/sync";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  describeMcpServerTransport,
  editMcpVariable,
  type McpVariableDraft,
  mcpServerNameError,
  mcpServerUrlValid,
  mcpVariableNameValid,
  parseMcpServerArgs,
  toggleToolAllowed,
  upsertMcpServer,
} from "./McpServersSettings.logic";
import { SecretInput } from "./SecretInput";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useScopedSettings } from "./useScopedSettings";
import { VaultSecretPicker } from "./VaultSecretPicker";

type TestOutcome =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly result: McpGatewayTestResult }
  | { readonly status: "failed"; readonly error: string };

/** Agents reach these through the `t3-code` MCP server, so every provider gets them at once. */
export function McpServersSettings() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection id="mcp-servers" title={gt("Shared MCP servers")}>
        <SettingsScopeNotice target="environment">
          {gt("Choose one environment to manage the MCP servers it shares with agents.")}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  if (environment.serverConfig?.environment.capabilities.mcpGateway !== true) {
    return (
      <SettingsSection id="mcp-servers" title={gt("Shared MCP servers")}>
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">
          <T>Update this environment's server to share MCP servers with agents.</T>
        </p>
      </SettingsSection>
    );
  }
  return <McpServersForm key={environment.environmentId} />;
}

function McpServersForm() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const servers = useScopedSettings((settings) => settings.mcpServers);
  const canEdit = useAtomValue(serverEnvironment.mcpGatewayTest.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const readStatus = useAtomCommand(serverEnvironment.mcpGatewayStatus, { reportFailure: false });
  const testServer = useAtomCommand(serverEnvironment.mcpGatewayTest, { reportFailure: false });
  const [statuses, setStatuses] = useState<ReadonlyArray<McpGatewayServerStatus>>([]);
  const [tests, setTests] = useState<Record<string, TestOutcome>>({});
  // Bumped when a server's connection or enabled state changes, so a test of the old settings is
  // dropped. A tool policy change keeps the result, since the tool checklist is rendered from it.
  const testGenerations = useRef(new Map<string, number>());
  const [editing, setEditing] = useState<{ server: McpServerConfig; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const syncView = useSyncViews().find((view) => view.environmentId === environmentId);
  const syncsMcpServers =
    syncView?.snapshot.participation?.enabled === true &&
    syncView.snapshot.participation.categories.includes("mcpServers");

  const refreshStatus = useEffectEvent(async () => {
    if (!environmentId) return;
    const response = await readStatus({ environmentId, input: {} });
    if (response._tag === "Success") setStatuses(response.value.servers);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the shared MCP servers' live status from the server once when the page opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void refreshStatus();
  }, []);

  const save = async (next: ReadonlyArray<McpServerConfig>) => {
    if (!environmentId) return false;
    setBusy(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { mcpServers: next } },
    });
    setBusy(false);
    void refreshStatus();
    return result._tag === "Success";
  };

  const runTest = async (server: McpServerConfig) => {
    if (!environmentId) return;
    const generation = (testGenerations.current.get(server.id) ?? 0) + 1;
    testGenerations.current.set(server.id, generation);
    setTests((previous) => ({ ...previous, [server.id]: { status: "pending" } }));
    const response = await testServer({ environmentId, input: { serverId: server.id } });
    const outcome: TestOutcome =
      response._tag === "Success"
        ? { status: "done", result: response.value }
        : {
            status: "failed",
            error: (() => {
              const error = Cause.squash(response.cause);
              return error instanceof Error
                ? error.message
                : resolveNow(msg("The connection test failed."));
            })(),
          };
    if (testGenerations.current.get(server.id) !== generation) return;
    setTests((previous) => ({ ...previous, [server.id]: outcome }));
    void refreshStatus();
  };

  // A test describes the settings it ran against, so a changed or removed server drops it.
  const forgetTest = (serverId: string) => {
    testGenerations.current.set(serverId, (testGenerations.current.get(serverId) ?? 0) + 1);
    setTests((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => id !== serverId)),
    );
  };

  const saveServer = async (server: McpServerConfig) => {
    const saved = await save(upsertMcpServer(servers, server));
    if (saved) forgetTest(server.id);
    return saved;
  };

  const remove = async (serverId: string) => {
    if (await save(servers.filter((candidate) => candidate.id !== serverId))) forgetTest(serverId);
  };

  return (
    <SettingsSection
      id="mcp-servers"
      title={gt("Shared MCP servers")}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canEdit || busy || editing !== null}
          onClick={() =>
            setEditing({
              isNew: true,
              server: {
                id: randomUUID(),
                name: "",
                enabled: true,
                transport: { type: "stdio", command: "", args: [] },
                environment: [],
                headers: [],
                toolPolicy: { mode: "all", tools: [], readOnlyClientsMayCall: "readOnlyHint" },
              },
            })
          }
        >
          <PlusIcon className="size-3.5" /> <T>Add server</T>
        </Button>
      }
    >
      <div className="px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          <T>
            Every agent in every thread on this environment can use these servers through Par3,
            whichever provider runs it. Add a server here or in a provider's own MCP config, not
            both. A command server runs on this environment's machine.
          </T>
        </p>
        {servers.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            <T>No shared MCP servers yet.</T>
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border/60">
            {servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                status={statuses.find((status) => status.id === server.id)}
                test={tests[server.id]}
                needsVault={
                  syncsMcpServers &&
                  syncView.snapshot.items.some(
                    (item) =>
                      item.key === `mcpServers:${server.id}` && item.skipped === "needs-vault",
                  )
                }
                disabled={!canEdit || busy}
                onToggle={(enabled) => void saveServer({ ...server, enabled })}
                onPolicy={(toolPolicy) =>
                  void save(upsertMcpServer(servers, { ...server, toolPolicy }))
                }
                onEdit={() => setEditing({ server, isNew: false })}
                onTest={() => void runTest(server)}
                onRemove={() => void remove(server.id)}
              />
            ))}
          </ul>
        )}
      </div>
      {editing ? (
        <McpServerEditor
          key={editing.server.id}
          server={editing.server}
          environmentId={environmentId}
          isNew={editing.isNew}
          servers={servers}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (server) => {
            if (await saveServer(server)) setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function statusPresentation(
  server: McpServerConfig,
  status: McpGatewayServerStatus | undefined,
  test: TestOutcome | undefined,
  resolve: MessageResolver,
) {
  if (!server.enabled) {
    return { label: resolve(msg("Disabled")), dot: "bg-muted-foreground/40" };
  }
  if (test?.status === "pending") return { label: resolve(msg("Testing…")), dot: "bg-warning" };
  if (test?.status === "failed") {
    return { label: resolve(msg("Connection failed")), dot: "bg-destructive" };
  }
  switch (status?.state) {
    case "connected":
      return {
        label:
          status.toolCount === undefined
            ? resolve(msg("Connected"))
            : resolve(
                msg("Connected · {count, plural, one {{count} tool} other {{count} tools}}", {
                  count: status.toolCount,
                }),
              ),
        dot: "bg-success",
      };
    case "error":
      return { label: resolve(msg("Connection failed")), dot: "bg-destructive" };
    default:
      return { label: resolve(msg("Connects on first use")), dot: "bg-muted-foreground/40" };
  }
}

function McpServerRow(props: {
  readonly server: McpServerConfig;
  readonly status: McpGatewayServerStatus | undefined;
  readonly test: TestOutcome | undefined;
  readonly needsVault: boolean;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onPolicy: (policy: McpServerConfig["toolPolicy"]) => void;
  readonly onEdit: () => void;
  readonly onTest: () => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { server, status, test } = props;
  const presentation = statusPresentation(server, status, test, m);
  const error =
    test?.status === "failed" ? test.error : status?.state === "error" ? status.error : undefined;
  const tools = test?.status === "done" ? test.result.tools : null;
  const offered = tools?.map((tool) => tool.name) ?? [];
  return (
    <li className="px-3 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium">{server.name}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ConnectionStatusDot dotClassName={presentation.dot} />
              {presentation.label}
            </span>
          </div>
          {server.description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{server.description}</p>
          ) : null}
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {describeMcpServerTransport(server)}
          </p>
          {props.needsVault ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              <T>
                Holds a saved secret;{" "}
                <Link to="/settings/sync" className="underline underline-offset-2">
                  move it to the vault
                </Link>{" "}
                to sync.
              </T>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            size="sm"
            checked={server.enabled}
            disabled={props.disabled}
            aria-label={gt("Share {name} with agents", { name: server.name })}
            onCheckedChange={props.onToggle}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={props.disabled}
                  aria-label={gt("{name} options", { name: server.name })}
                />
              }
            >
              <MoreVertical />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={props.onTest}>
                <T>Test connection</T>
              </MenuItem>
              <MenuItem onClick={props.onEdit}>
                <T>Edit</T>
              </MenuItem>
              <MenuItem variant="destructive" onClick={props.onRemove}>
                <T>Remove</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {error ? (
        <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {tools ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              <T>Tools agents may call</T>
            </span>
            {server.toolPolicy.mode === "allow" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={props.disabled}
                onClick={() => props.onPolicy({ ...server.toolPolicy, mode: "all" })}
              >
                <T>Allow all</T>
              </Button>
            ) : null}
          </div>
          {tools.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <T>This server offers no tools.</T>
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <label className="flex items-start gap-2 text-xs">
                    <Checkbox
                      checked={
                        server.toolPolicy.mode === "all" ||
                        server.toolPolicy.tools.includes(tool.name)
                      }
                      disabled={props.disabled}
                      onCheckedChange={(checked) =>
                        props.onPolicy(
                          toggleToolAllowed(server.toolPolicy, offered, tool.name, checked),
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="font-mono">{tool.name}</span>
                      {tool.annotations?.readOnlyHint ? (
                        <span className="text-muted-foreground">
                          {" · "}
                          <T>read-only</T>
                        </span>
                      ) : null}
                      {tool.description ? (
                        <span className="block truncate text-muted-foreground">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

type Variable = McpVariableDraft;

const withKey = (variable: McpServerHeader): Variable => ({
  ...variable,
  key: randomUUID(),
  ...(variable.valueRedacted ? { savedSecretName: variable.name } : {}),
});
const withoutKey = ({
  key: _key,
  savedSecretName: _saved,
  ...variable
}: Variable): McpServerHeader => ({
  ...variable,
  name: variable.name.trim(),
});

function VariablesEditor(props: {
  readonly label: string;
  readonly namePlaceholder: string;
  readonly variables: ReadonlyArray<Variable>;
  readonly environmentId: EnvironmentId | null;
  readonly disabled: boolean;
  readonly onChange: (variables: ReadonlyArray<Variable>) => void;
}) {
  const gt = useGT();
  const edit = (index: number, change: Parameters<typeof editMcpVariable>[1]) =>
    props.onChange(
      props.variables.map((variable, at) =>
        at === index ? editMcpVariable(variable, change) : variable,
      ),
    );
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between">
        <span>{props.label}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={props.disabled}
          onClick={() =>
            props.onChange([...props.variables, withKey({ name: "", value: "", sensitive: true })])
          }
        >
          <PlusIcon className="size-3.5" /> <T>Add</T>
        </Button>
      </div>
      {props.variables.map((variable, index) => (
        <div
          key={variable.key}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] gap-2"
        >
          <Input
            aria-label={gt("{label} name", { label: props.label })}
            value={variable.name}
            disabled={props.disabled}
            spellCheck={false}
            placeholder={props.namePlaceholder}
            onChange={(event) => edit(index, { name: event.target.value })}
          />
          {variable.sensitive ? (
            <div className="flex min-w-0 items-center gap-1">
              <SecretInput
                aria-label={gt("{label} value", { label: props.label })}
                configured={variable.valueRedacted === true}
                value={variable.valueRedacted ? "" : variable.value}
                disabled={props.disabled}
                onChange={(event) => edit(index, { value: event.target.value })}
              />
              <VaultSecretPicker
                environmentId={props.environmentId}
                disabled={props.disabled}
                onPick={(value) => edit(index, { value })}
              />
            </div>
          ) : (
            <Input
              aria-label={gt("{label} value", { label: props.label })}
              value={variable.value}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event) => edit(index, { value: event.target.value })}
            />
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={variable.sensitive}
              disabled={props.disabled}
              onCheckedChange={(sensitive) =>
                edit(index, { value: variable.valueRedacted ? "" : variable.value, sensitive })
              }
            />
            <T>Secret</T>
          </label>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            disabled={props.disabled}
            aria-label={
              variable.name ? gt("Remove {name}", { name: variable.name }) : gt("Remove entry")
            }
            onClick={() => props.onChange(props.variables.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

function McpServerEditor(props: {
  readonly server: McpServerConfig;
  readonly environmentId: EnvironmentId | null;
  readonly isNew: boolean;
  readonly servers: ReadonlyArray<McpServerConfig>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (server: McpServerConfig) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [draft, setDraft] = useState(props.server);
  const [environment, setEnvironment] = useState<ReadonlyArray<Variable>>(() =>
    props.server.environment.map(withKey),
  );
  const [headers, setHeaders] = useState<ReadonlyArray<Variable>>(() =>
    props.server.headers.map(withKey),
  );
  const [argsText, setArgsText] = useState(
    props.server.transport.type === "stdio" ? props.server.transport.args.join("\n") : "",
  );
  const nameError = mcpServerNameError(draft.name, props.servers, draft.id, m);
  const transport = draft.transport;
  const transportReady =
    transport.type === "stdio" ? transport.command.trim() !== "" : mcpServerUrlValid(transport.url);
  // Only the visible list is saved, so an entry in the hidden one cannot block saving.
  const variablesReady =
    transport.type === "stdio"
      ? environment.every((variable) => mcpVariableNameValid("env", variable.name))
      : headers.every((header) => mcpVariableNameValid("header", header.name));
  const valid = nameError === null && transportReady && variablesReady;
  const { description, ...rest } = draft;
  const build = (): McpServerConfig => ({
    ...rest,
    name: draft.name.trim(),
    ...(description?.trim() ? { description: description.trim() } : {}),
    transport:
      transport.type === "stdio"
        ? {
            type: "stdio",
            command: transport.command.trim(),
            args: parseMcpServerArgs(argsText),
            ...(transport.cwd?.trim() ? { cwd: transport.cwd.trim() } : {}),
          }
        : { type: "http", url: transport.url.trim() },
    // A server keeps only the variables or headers its connection type uses.
    environment: transport.type === "stdio" ? environment.map(withoutKey) : [],
    headers: transport.type === "http" ? headers.map(withoutKey) : [],
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!props.busy}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !props.busy) props.onSave(build());
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{props.isNew ? gt("Add MCP server") : gt("Edit MCP server")}</DialogTitle>
          <DialogDescription>
            <T>
              Agents call its tools through Par3 as{" "}
              <code>
                <Var>{draft.name.trim() || "name"}</Var>
              </code>
              .
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>
              <T>Name</T>
            </span>
            <Input
              autoFocus
              required
              value={draft.name}
              disabled={props.busy}
              spellCheck={false}
              placeholder="linear"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            {draft.name !== "" && nameError ? (
              <span className="block text-xs text-destructive">{nameError}</span>
            ) : null}
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>
              <T>Description for agents</T>
            </span>
            <Input
              value={draft.description ?? ""}
              disabled={props.busy}
              placeholder={gt("Issues and projects for the platform team")}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <ToggleGroup
            aria-label={gt("Connection type")}
            variant="segmented"
            value={[transport.type]}
            onValueChange={(next) => {
              const type = next[0];
              if (type === "stdio" && transport.type !== "stdio") {
                setDraft({ ...draft, transport: { type: "stdio", command: "", args: [] } });
              } else if (type === "http" && transport.type !== "http") {
                setDraft({ ...draft, transport: { type: "http", url: "" } });
              }
            }}
          >
            <Toggle value="stdio">
              <T>Command</T>
            </Toggle>
            <Toggle value="http">HTTP</Toggle>
          </ToggleGroup>
          {transport.type === "stdio" ? (
            <>
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>Command</T>
                </span>
                <Input
                  required
                  value={transport.command}
                  disabled={props.busy}
                  spellCheck={false}
                  placeholder="npx"
                  onChange={(event) =>
                    setDraft({ ...draft, transport: { ...transport, command: event.target.value } })
                  }
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>Arguments, one per line</T>
                </span>
                <Textarea
                  value={argsText}
                  disabled={props.busy}
                  spellCheck={false}
                  placeholder={"-y\n@modelcontextprotocol/server-everything"}
                  onChange={(event) => setArgsText(event.target.value)}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>Working directory</T>
                </span>
                <Input
                  value={transport.cwd ?? ""}
                  disabled={props.busy}
                  spellCheck={false}
                  placeholder={gt("The server's own directory")}
                  onChange={(event) =>
                    setDraft({ ...draft, transport: { ...transport, cwd: event.target.value } })
                  }
                />
              </label>
              <VariablesEditor
                label={gt("Environment variables")}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- example environment variable name
                namePlaceholder="API_KEY"
                variables={environment}
                environmentId={props.environmentId}
                disabled={props.busy}
                onChange={setEnvironment}
              />
            </>
          ) : (
            <>
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>URL</T>
                </span>
                <Input
                  required
                  type="url"
                  value={transport.url}
                  disabled={props.busy}
                  spellCheck={false}
                  placeholder="https://mcp.company.test/mcp"
                  onChange={(event) =>
                    setDraft({ ...draft, transport: { type: "http", url: event.target.value } })
                  }
                />
              </label>
              <VariablesEditor
                label={gt("Headers")}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- HTTP header name
                namePlaceholder="Authorization"
                variables={headers}
                environmentId={props.environmentId}
                disabled={props.busy}
                onChange={setHeaders}
              />
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" disabled={props.busy || !valid}>
            {props.busy ? <Spinner size="xs" /> : null} <T>Save server</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

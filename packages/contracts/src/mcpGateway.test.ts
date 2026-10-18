import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodePatch = Schema.decodeUnknownExit(ServerSettingsPatch);
const decodeSettings = Schema.decodeUnknownExit(ServerSettings);

const http = (id: string, name: string, url: string) => ({
  id,
  name,
  transport: { type: "http", url },
});

describe("mcpServers settings", () => {
  it("saves servers with distinct ids and names and http(s) URLs", () => {
    const exit = decodePatch({
      mcpServers: [
        http("a", "linear", "https://mcp.company.test/mcp"),
        http("b", "sentry", "http://localhost:4000/mcp"),
      ],
    });
    expect(exit._tag).toBe("Success");
  });

  it("refuses to save duplicate ids or names, or a URL Par3 cannot reach over HTTP", () => {
    for (const [mcpServers, message] of [
      [[http("a", "linear", "https://x.test"), http("a", "sentry", "https://y.test")], "id"],
      [[http("a", "linear", "https://x.test"), http("b", "linear", "https://y.test")], "name"],
      [[http("a", "linear", "mcp.company.test/mcp")], "http or https URL"],
      [[http("a", "linear", "file:///etc/passwd")], "http or https URL"],
    ] as const) {
      const exit = decodePatch({ mcpServers });
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain(message);
    }
  });

  it("still loads stored settings that predate those checks", () => {
    const exit = decodeSettings({
      mcpServers: [
        http("a", "linear", "mcp.company.test/mcp"),
        http("a", "linear", "https://mcp.company.test/mcp"),
      ],
    });
    expect(exit._tag).toBe("Success");
  });
});

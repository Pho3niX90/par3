/**
 * GitHub Copilot server entry: the driver and adapter driver the server registers.
 *
 * @module provider-copilot/server
 */
export { CopilotDriver, type CopilotDriverEnv } from "./server/driver.ts";
export { type CopilotAdapterV2DriverEnv } from "./server/adapter.ts";

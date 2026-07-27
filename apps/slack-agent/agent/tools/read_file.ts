import { disableTool } from "eve/tools";

/**
 * Reads sandbox files. The agent's data comes from Maple's MCP tools, never from disk, and a read tool is an exfiltration primitive the moment injected text points it at something.
 *
 * Disabled for the same reason as agent/tools/bash.ts: the agent reads
 * attacker-influenced customer telemetry, and every framework tool left on is
 * reachable by injected text with no approval prompt. See that file for the
 * naming contract.
 */
export default disableTool();

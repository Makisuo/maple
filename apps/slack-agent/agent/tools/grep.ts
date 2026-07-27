import { disableTool } from "eve/tools"

/**
 * Filesystem content search over the sandbox; this agent has no files to search.
 *
 * Disabled for the same reason as agent/tools/bash.ts: the agent reads
 * attacker-influenced customer telemetry, and every framework tool left on is
 * reachable by injected text with no approval prompt. See that file for the
 * naming contract.
 */
export default disableTool()

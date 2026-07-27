import { disableTool } from "eve/tools";

/**
 * Provider-run web search. The agent answers from the org's own telemetry via
 * the Maple MCP tools; a search tool adds no capability it needs, but does add
 * a path for injected text to push arbitrary strings (which can carry the
 * telemetry the model just read) out to a third party.
 *
 * See agent/tools/bash.ts for the filename→tool-name contract.
 */
export default disableTool();

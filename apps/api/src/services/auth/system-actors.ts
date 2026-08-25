/**
 * Reserved agent-actor names — canonical definitions live in
 * `@maple/domain/system-agents` so the web can render first-party agents
 * distinctly; this module remains the API-side import point.
 */
export {
	isReservedAgentName,
	RESERVED_AGENT_NAMES,
	RESOLUTION_AGENT_NAME,
	SYSTEM_ALERTS_AGENT_NAME,
	SYSTEM_ERRORS_AGENT_NAME,
	TRIAGE_AGENT_NAME,
} from "@maple/domain/system-agents"

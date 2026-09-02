/**
 * Reserved agent-actor names — canonical definitions live in
 * `@maple/domain/system-agents` so the web can render first-party agents
 * distinctly; this module remains the API-side import point.
 */
export {
	isReservedAgentName,
	SYSTEM_ALERTS_AGENT_NAME,
	SYSTEM_ERRORS_AGENT_NAME,
	TRIAGE_AGENT_NAME,
} from "@maple/domain/system-agents"

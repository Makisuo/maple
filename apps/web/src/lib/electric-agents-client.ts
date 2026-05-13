/**
 * URL of the electric-ax agents-server. The frontend connects directly to
 * it to observe entity streams (via `createAgentsClient`). Spawn + send
 * still go through our Node chat-agent at `chatAgentUrl` for auth.
 */
export const agentsUrl: string =
	import.meta.env.VITE_AGENTS_URL ?? "http://localhost:4440"

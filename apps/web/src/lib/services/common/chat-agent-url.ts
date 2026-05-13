/**
 * URL of the Maple chat-agent Node server (Electric Agents runtime). The web
 * app POSTs user messages here and receives webhook-style wake-ups through
 * the agents-server it talks to in turn.
 */
export const chatAgentUrl: string =
	import.meta.env.VITE_CHAT_AGENT_URL ?? "http://localhost:4700"

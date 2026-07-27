import { type ReactNode, useMemo } from "react"
import { FlueProvider } from "@flue/react"
import { createFlueClient } from "@flue/sdk"
import { flueChatUrl } from "@/lib/services/common/flue-chat-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { tracedFetch } from "@/lib/services/common/telemetry"

/**
 * Provides a `@flue/sdk` client to the chat hooks. The `headers` resolver runs
 * per HTTP request (and per Durable-Streams reconnect), so it always attaches a
 * fresh Clerk session token — the chat-flue worker's `/agents/*` middleware
 * verifies it and checks the caller's org owns the addressed instance.
 */
export function FlueClientProvider({ children }: { children: ReactNode }) {
	const client = useMemo(
		() =>
			createFlueClient({
				baseUrl: flueChatUrl,
				fetch: (input, init) => tracedFetch("maple-chat-flue", input, init),
				headers: async (): Promise<Record<string, string>> => {
					const headers = await getMapleAuthHeaders()
					return headers.authorization ? { Authorization: headers.authorization } : {}
				},
			}),
		[],
	)
	return <FlueProvider client={client}>{children}</FlueProvider>
}

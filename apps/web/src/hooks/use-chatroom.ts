/**
 * Subscribe to a chatroom's shared-state message collection via the
 * Electric Agents runtime. Returns a TanStack DB `Collection` that the
 * caller drives with `useLiveQuery` for reactive renders.
 *
 * Pattern lifted from the upstream `agents-chat-starter` example
 * (`src/ui/hooks/useChatroom.ts`); narrowed to a single collection because
 * Maple's chat is one assistant per tab rather than a multi-agent room.
 */
import { useEffect, useState } from "react"
import { createAgentsClient, db } from "@electric-ax/agents-runtime"
import type { Collection } from "@tanstack/react-db"
import { chatroomSchema, type ChatMessage } from "@maple/domain/chat"
import { agentsUrl } from "@/lib/electric-agents-client"

export type MessagesCollection = Collection<ChatMessage>

async function retry<T>(
	fn: () => Promise<T>,
	attempts = 10,
	delay = 500,
): Promise<T> {
	let lastErr: unknown
	for (let i = 0; i < attempts; i += 1) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (i === attempts - 1) break
			await new Promise((r) => setTimeout(r, delay))
		}
	}
	throw lastErr ?? new Error("retry exhausted")
}

export function useChatroom(chatroomId: string | null): {
	messages: MessagesCollection | null
	error: string | null
} {
	const [messages, setMessages] = useState<MessagesCollection | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!chatroomId) {
			setMessages(null)
			setError(null)
			return
		}
		let cancelled = false
		let close: () => void = () => {}
		;(async () => {
			try {
				const client = createAgentsClient({ baseUrl: agentsUrl })
				const handle = await retry(() => client.observe(db(chatroomId, chatroomSchema)))
				if (cancelled) {
					;(handle as unknown as { close?: () => void }).close?.()
					return
				}
				close = () => (handle as unknown as { close?: () => void }).close?.() ?? undefined
				const collection = (handle as unknown as {
					collections: { messages: MessagesCollection }
				}).collections.messages
				setMessages(collection)
				setError(null)
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
			close()
		}
	}, [chatroomId])

	return { messages, error }
}

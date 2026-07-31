import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/expo"
import { useFlueAgent } from "@flue/react"
import type { UIMessage } from "../lib/chat-types"
import type { AlertContext } from "../lib/alert-context"
import {
	loadMessages,
	previewFromMessage,
	saveMessages,
	titleFromFirstUserText,
	upsertThread,
} from "../lib/chat-threads"
import { makeFlueChatClient } from "../lib/flue-chat-client"
import { toMobileMessages } from "../lib/flue-message-mapping"
import { buildAlertPreamble } from "../lib/context-preamble"

type Status = "idle" | "submitted" | "streaming" | "error"

interface UseMobileChatOptions {
	threadId: string
	alertContext?: AlertContext
}

/** Flue's `connecting` has no composer equivalent — treat it as ready. */
const toStatus = (status: string): Status =>
	status === "submitted" || status === "streaming" || status === "error" ? status : "idle"

/**
 * `ToolUIPart["type"]` is a widened `string` (it carries `tool-<name>`), so the
 * part union cannot discriminate on `type` — narrow on the property instead.
 */
const firstUserText = (messages: readonly UIMessage[]): string => {
	for (const message of messages) {
		if (message.role !== "user") continue
		for (const part of message.parts) {
			if ("text" in part) return part.text
		}
	}
	return ""
}

/**
 * Mobile chat over the Flue conversation client.
 *
 * Flue 2 serves a MATERIALIZED conversation rather than a delta stream, so the
 * transcript is server-owned: `useFlueAgent` replays history on mount and keeps
 * it live, which retired the hand-rolled reducer (assistant-bubble bookkeeping,
 * text-delta accumulation, tool-part patching) this hook used to carry.
 *
 * The local message cache survives for one job only: seeding the transcript
 * before the network answers, and feeding the offline thread list
 * (title/preview/timestamp). It is no longer the source of truth.
 */
export function useMobileChat({ threadId, alertContext }: UseMobileChatOptions) {
	const { orgId, getToken } = useAuth()
	const client = useMemo(
		() => (orgId ? makeFlueChatClient(orgId, threadId, getToken) : undefined),
		[orgId, threadId, getToken],
	)
	const agent = useFlueAgent({ client })

	const [cached, setCached] = useState<UIMessage[]>([])
	const [cacheLoaded, setCacheLoaded] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		void loadMessages(threadId).then((persisted) => {
			if (cancelled) return
			setCached(persisted)
			setCacheLoaded(true)
		})
		return () => {
			cancelled = true
		}
	}, [threadId])

	const messages = useMemo(() => toMobileMessages(agent.messages), [agent.messages])

	// Show the cache only until the durable history lands, so a reconnect never
	// flashes stale content over the live transcript.
	const visible = agent.historyReady ? messages : cached
	const hydrated = agent.historyReady || cacheLoaded

	// Mirror the server transcript into the cache + thread summary once it settles.
	const status = toStatus(agent.status)
	const settled = agent.historyReady && status === "idle"
	const lastMirrored = useRef<string | null>(null)
	useEffect(() => {
		if (!settled || messages.length === 0) return
		const fingerprint = `${messages.length}:${messages[messages.length - 1]?.id ?? ""}`
		if (lastMirrored.current === fingerprint) return
		lastMirrored.current = fingerprint
		void saveMessages(threadId, messages)
		void upsertThread({
			threadId,
			title: titleFromFirstUserText(firstUserText(messages)),
			lastMessagePreview: previewFromMessage(messages[messages.length - 1]),
			lastMessageAt: Date.now(),
			alertContext,
		})
	}, [settled, messages, threadId, alertContext])

	const sendMessage = useCallback(
		(text: string) => {
			if (!client) {
				setSendError("No organization — sign in first")
				return
			}
			const userText = text.trim()
			if (!userText) return
			if (status === "submitted" || status === "streaming") return

			setSendError(null)

			// Alert context is folded into the FIRST message of a fresh thread. Flue
			// records the submitted prompt verbatim, so the preamble is visible in the
			// transcript — same tradeoff the web client makes.
			const isFirst = agent.messages.length === 0
			const preamble = isFirst && alertContext ? buildAlertPreamble(alertContext) : ""
			void agent.sendMessage(preamble ? `${preamble}\n\n---\n\n${userText}` : userText)
		},
		[client, status, agent, alertContext],
	)

	const stop = useCallback(() => {
		void client?.abort().catch(() => {
			// Best-effort cancel: the turn settles on its own if the abort never lands.
		})
	}, [client])

	return {
		messages: visible,
		status,
		error: sendError ?? agent.error?.message ?? null,
		hydrated,
		sendMessage,
		stop,
	}
}

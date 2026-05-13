import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
import { agentsUrl } from "@/lib/electric-agents-client"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { RichText } from "@/components/ai-elements/rich-text"
import {
	PromptInput,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputSubmit,
} from "@/components/ai-elements/prompt-input"
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion"
import { Shimmer } from "@/components/ai-elements/shimmer"

const DEFAULT_SUGGESTIONS = [
	"What's the overall system health?",
	"Show me the slowest traces",
	"Are there any errors right now?",
	"Which services have the highest error rate?",
]

interface ChatConversationProps {
	tabId: string
	isActive: boolean
	onFirstMessage?: (tabId: string, text: string) => void
}

interface StreamEventBase {
	type: string
	key: string
	value: Record<string, unknown>
	headers?: { operation?: string; offset?: string }
}
type UserMessageSection = {
	kind: "user_message"
	key: string
	text: string
}
type AgentReplySection = {
	kind: "agent_response"
	runId: string
	text: string
	done: boolean
}
type RenderSection = UserMessageSection | AgentReplySection

function buildSectionsFromEvents(events: StreamEventBase[]): RenderSection[] {
	// Walk events in stream order. Emit each `agent_response` section at the
	// point its `run` starts so user messages and agent replies stay
	// interleaved correctly (U1 → A1 → U2 → A2 instead of U1, U2, A1, A2).
	const sections: RenderSection[] = []
	const agentByRunId = new Map<string, AgentReplySection>()

	for (const e of events) {
		const v = e.value
		if (e.type === "inbox") {
			const payload = v.payload as { text?: string } | undefined
			if (v.message_type === "user_message" && payload?.text) {
				sections.push({ kind: "user_message", key: e.key, text: payload.text })
			}
			continue
		}
		if (e.type === "run") {
			const runId = e.key
			const status = v.status as string | undefined
			let section = agentByRunId.get(runId)
			if (!section) {
				section = { kind: "agent_response", runId, text: "", done: false }
				agentByRunId.set(runId, section)
				sections.push(section)
			}
			if (status === "completed") section.done = true
			continue
		}
		if (e.type === "text_delta") {
			const runId = (v.run_id as string) ?? ""
			if (!runId) continue
			let section = agentByRunId.get(runId)
			if (!section) {
				// text_delta arrived before its run row — synthesize an empty
				// agent_response so the deltas have somewhere to land.
				section = { kind: "agent_response", runId, text: "", done: false }
				agentByRunId.set(runId, section)
				sections.push(section)
			}
			section.text += (v.delta as string) ?? ""
		}
	}

	return sections
}

export function ChatConversation({ tabId, isActive, onFirstMessage }: ChatConversationProps) {
	const { orgId, getToken } = useAuth()
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	useTypeAnywhereFocus(textareaRef, isActive)

	const [streamUrl, setStreamUrl] = useState<string | null>(null)
	const [events, setEvents] = useState<StreamEventBase[]>([])
	const [connectionError, setConnectionError] = useState<string | null>(null)
	const [isAwaitingReply, setIsAwaitingReply] = useState(false)

	const getTokenRef = useRef(getToken)
	useEffect(() => {
		getTokenRef.current = getToken
	}, [getToken])

	// Step 1: POST /init → spawn entity (idempotent) + get the stream URL.
	useEffect(() => {
		if (!orgId) {
			setStreamUrl(null)
			return
		}
		let cancelled = false
		setConnectionError(null)
		;(async () => {
			try {
				const token = await getTokenRef.current()
				const res = await fetch(
					`${chatAgentUrl}/api/chat/${encodeURIComponent(tabId)}/init`,
					{
						method: "POST",
						headers: token ? { Authorization: `Bearer ${token}` } : {},
					},
				)
				if (!res.ok) throw new Error(`init failed (${res.status})`)
				const { entityUrl } = (await res.json()) as {
					entityUrl: string
					streamUrl: string
				}
				if (cancelled) return
				setStreamUrl(`${agentsUrl}${entityUrl}/main`)
			} catch (err) {
				if (cancelled) return
				setConnectionError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [orgId, tabId])

	// Step 2: subscribe to the entity stream via SSE so we get token-by-token
	// streaming. We use the EventSource directly instead of `useChat(db)` /
	// `createEntityStreamDB` because the durable-streams-state-beta consumer
	// inside @electric-ax/agents-runtime buffers all dispatched events in a
	// pending handler that only commits on `markUpToDate()` — and the
	// agents-server's entity-stream proxy never emits `upToDate:true` in its
	// SSE control frames. So events arrive but never become collection rows.
	// TODO(upstream): switch back to `useChat(db)` once the agents-server
	// emits `upToDate` (tracked as PR-A in upstream-electric-agents-fixes).
	useEffect(() => {
		if (!streamUrl) {
			setEvents([])
			return
		}
		let cancelled = false
		const abort = new AbortController()
		const consume = async () => {
			try {
				const res = await fetch(`${streamUrl}?offset=-1&live=sse`, {
					headers: { Accept: "text/event-stream" },
					signal: abort.signal,
				})
				if (!res.ok || !res.body) {
					throw new Error(`stream ${res.status}`)
				}
				const reader = res.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ""
				let currentEvent: { name: string | null; data: string[] } = {
					name: null,
					data: [],
				}
				const dispatchFrame = () => {
					if (currentEvent.name !== "data" || currentEvent.data.length === 0) {
						currentEvent = { name: null, data: [] }
						return
					}
					const payload = currentEvent.data.join("\n")
					currentEvent = { name: null, data: [] }
					let parsed: unknown
					try {
						parsed = JSON.parse(payload)
					} catch {
						return
					}
					const incoming = Array.isArray(parsed)
						? (parsed as StreamEventBase[])
						: [parsed as StreamEventBase]
					setEvents((prev) => [...prev, ...incoming])
				}
				while (!cancelled) {
					const { value, done } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					// SSE frames are delimited by blank lines; parse line by line.
					let nl: number
					while ((nl = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, nl).replace(/\r$/, "")
						buffer = buffer.slice(nl + 1)
						if (line === "") {
							dispatchFrame()
							continue
						}
						if (line.startsWith("event:")) {
							currentEvent.name = line.slice(6).trim()
						} else if (line.startsWith("data:")) {
							currentEvent.data.push(line.slice(5).replace(/^ /, ""))
						}
					}
				}
			} catch (err) {
				if (cancelled) return
				if ((err as { name?: string }).name === "AbortError") return
				console.warn("[chat] sse read failed", err)
			}
		}
		void consume()
		return () => {
			cancelled = true
			abort.abort()
		}
	}, [streamUrl])

	const sections = useMemo(() => buildSectionsFromEvents(events), [events])

	const lastSection = sections[sections.length - 1]
	const agentRunInProgress =
		lastSection?.kind === "agent_response" && !lastSection.done
	const isLoading = isAwaitingReply || agentRunInProgress
	useEffect(() => {
		if (lastSection?.kind === "agent_response" && lastSection.done) {
			setIsAwaitingReply(false)
		}
	}, [lastSection])

	const sendMessage = useCallback(
		async (text: string) => {
			if (!text.trim() || !orgId) return
			const token = await getTokenRef.current()
			const res = await fetch(
				`${chatAgentUrl}/api/chat/${encodeURIComponent(tabId)}/message`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ text }),
				},
			)
			if (!res.ok) {
				const body = await res.text().catch(() => "")
				throw new Error(`send failed (${res.status}): ${body || res.statusText}`)
			}
		},
		[orgId, tabId],
	)

	const messageCount = sections.length
	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		setHasSettled(false)
	}, [tabId])
	useEffect(() => {
		if (messageCount > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messageCount, tabId])

	const handleSend = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed || isLoading) return
		if (messageCount === 0 && onFirstMessage) {
			onFirstMessage(tabId, trimmed.slice(0, 40))
		}
		setIsAwaitingReply(true)
		void sendMessage(trimmed).catch((err) => {
			console.error("[chat] sendMessage failed", err)
			setIsAwaitingReply(false)
		})
	}

	return (
		<div className="flex h-full flex-col">
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && messageCount === 0 ? (
						<ConversationLoadingSkeleton />
					) : messageCount === 0 ? (
						<ConversationEmptyState
							title="Maple AI"
							description="Ask me about your traces, logs, errors, and services."
						>
							<div className="mt-4 flex flex-col items-center gap-3">
								<div className="space-y-1 text-center">
									<h3 className="text-sm font-medium">Maple AI</h3>
									<p className="text-muted-foreground text-sm">
										Ask me about your traces, logs, errors, and services.
									</p>
								</div>
								<Suggestions className="mt-2 justify-center">
									{DEFAULT_SUGGESTIONS.map((s) => (
										<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
									))}
								</Suggestions>
							</div>
						</ConversationEmptyState>
					) : (
						<>
							{sections.map((section) => {
								if (section.kind === "user_message") {
									return (
										<Message key={`u:${section.key}`} from="user">
											<MessageContent>
												<RichText>{section.text}</RichText>
											</MessageContent>
										</Message>
									)
								}
								return (
									<Message key={`a:${section.runId}`} from="assistant">
										<MessageContent>
											<RichText>{section.text}</RichText>
										</MessageContent>
									</Message>
								)
							})}
							{isAwaitingReply && lastSection?.kind === "user_message" && (
								<Message from="assistant">
									<MessageContent>
										<Shimmer>Thinking…</Shimmer>
									</MessageContent>
								</Message>
							)}
						</>
					)}
					{connectionError && (
						<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							Connection error: {connectionError}
						</div>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				{messageCount > 0 && (
					<Suggestions className="mb-3">
						{DEFAULT_SUGGESTIONS.map((s) => (
							<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
						))}
					</Suggestions>
				)}
				<PromptInput
					onSubmit={({ text }) => handleSend(text)}
					className="rounded-lg border shadow-sm"
				>
					<PromptInputTextarea
						ref={textareaRef}
						placeholder="Ask about your system..."
						disabled={isLoading}
					/>
					<PromptInputFooter>
						<PromptInputSubmit
							status={isLoading ? "streaming" : "ready"}
							disabled={isLoading}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	)
}

export function ConversationLoadingSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-6" aria-hidden>
			<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
			<div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
			<div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
		</div>
	)
}

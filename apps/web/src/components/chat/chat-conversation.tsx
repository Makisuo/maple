import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
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

// --- Stream event shapes (matches durable-streams JSON output) ----------------

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
	timestamp?: number
}
type AgentReplySection = {
	kind: "agent_response"
	runId: string
	text: string
	done: boolean
}
type RenderSection = UserMessageSection | AgentReplySection

interface RunState {
	status?: "started" | "completed" | "failed"
}

function buildSectionsFromEvents(events: StreamEventBase[]): RenderSection[] {
	const sections: RenderSection[] = []
	const deltasByRun = new Map<string, string[]>()
	const runStatus = new Map<string, RunState>()
	const runOrder: string[] = []

	for (const e of events) {
		const v = e.value
		if (e.type === "message_received") {
			const payload = v.payload as { text?: string } | undefined
			if (v.message_type === "user_message" && payload?.text) {
				sections.push({
					kind: "user_message",
					key: e.key,
					text: payload.text,
					timestamp:
						typeof v.timestamp === "string"
							? Date.parse(v.timestamp)
							: undefined,
				})
			}
		} else if (e.type === "run") {
			const runId = e.key
			if (!runStatus.has(runId)) runOrder.push(runId)
			runStatus.set(runId, { status: v.status as RunState["status"] })
		} else if (e.type === "text_delta") {
			const runId = (v.run_id as string) ?? ""
			if (!runId) continue
			if (!deltasByRun.has(runId)) {
				deltasByRun.set(runId, [])
				if (!runStatus.has(runId)) {
					runStatus.set(runId, {})
					runOrder.push(runId)
				}
			}
			deltasByRun.get(runId)!.push((v.delta as string) ?? "")
		}
	}

	// Inject agent_response sections in the order runs first appeared.
	for (const runId of runOrder) {
		const deltas = deltasByRun.get(runId) ?? []
		if (deltas.length === 0) continue
		sections.push({
			kind: "agent_response",
			runId,
			text: deltas.join(""),
			done: runStatus.get(runId)?.status === "completed",
		})
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

	// Stash getToken in a ref so its unstable reference (Clerk re-creates the
	// function on every render) doesn't retrigger the init effect.
	const getTokenRef = useRef(getToken)
	useEffect(() => {
		getTokenRef.current = getToken
	}, [getToken])

	// Step 1: call /init to spawn the entity (idempotent) and get the stream URL.
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
				if (!res.ok) {
					throw new Error(`init failed (${res.status})`)
				}
				const { streamUrl: url } = (await res.json()) as {
					streamUrl: string
				}
				if (cancelled) return
				setStreamUrl(url)
			} catch (err) {
				if (cancelled) return
				setConnectionError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [orgId, tabId])

	// Step 2: poll the stream URL. This bypasses the broken SSE/durable-streams
	// client integration in @electric-ax/agents-runtime@0.1.3 (where
	// `db.preload()` hangs on `markUpToDate` and `useChat`+`useLiveQuery`
	// never surface events). Plain JSON GET works fine.
	useEffect(() => {
		if (!streamUrl) {
			setEvents([])
			return
		}
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | null = null

		const poll = async () => {
			try {
				const res = await fetch(streamUrl, {
					headers: { Accept: "application/json" },
				})
				if (!res.ok) throw new Error(`stream ${res.status}`)
				const data = (await res.json()) as StreamEventBase[]
				if (cancelled) return
				setEvents(data)
			} catch (err) {
				if (cancelled) return
				console.warn("[chat] poll failed", err)
			} finally {
				if (!cancelled) timer = setTimeout(poll, 1000)
			}
		}
		void poll()

		return () => {
			cancelled = true
			if (timer) clearTimeout(timer)
		}
	}, [streamUrl])

	const sections = useMemo(() => buildSectionsFromEvents(events), [events])

	// Track whether the latest run completed; if the last section is a
	// user_message (or empty), we're awaiting the next agent reply.
	const lastSection = sections[sections.length - 1]
	const agentRunInProgress =
		lastSection?.kind === "agent_response" && !lastSection.done
	const showThinking = isAwaitingReply || agentRunInProgress
	useEffect(() => {
		if (lastSection?.kind === "agent_response" && lastSection.done) {
			setIsAwaitingReply(false)
		}
	}, [lastSection])

	const isLoading = showThinking

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

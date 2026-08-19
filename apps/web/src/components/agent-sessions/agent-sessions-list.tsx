import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { ChatBubbleSparkleIcon } from "@/components/icons"

/** The wire row from `listAiSessions` — one AI agent session, newest first. */
export interface AgentSessionRow {
	readonly sessionId: string
	readonly vendorId: string
	readonly vendorVersion: string
	readonly traceCount: number
	readonly spanCount: number
	readonly errorSpanCount: number
	readonly serviceNames: ReadonlyArray<string>
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
}

/**
 * Vendor ids the ingest gateway stamps (`AI_VENDORS` in
 * apps/ingest/src/ai_session.rs) → brand names. Listed here are the ids whose
 * brand casing the title-case fallback below can't derive — acronyms (SDK,
 * ADK), camel brands (LiteLLM, DSPy), and deliberately lowercase ones (eve,
 * smolagents). Anything unlisted falls back to Title Case with the `unknown:`
 * dialect prefix stripped, so a newly stamped vendor degrades to a readable
 * name instead of a raw id.
 */
const VENDOR_LABELS = new Map<string, string>([
	["claude_agent_sdk", "Claude Agent SDK"],
	["crewai", "CrewAI"],
	["dspy", "DSPy"],
	["effect_ai", "Effect AI"],
	["eve", "eve"],
	["google_adk", "Google ADK"],
	["langchain", "LangChain"],
	["litellm", "LiteLLM"],
	["llamaindex", "LlamaIndex"],
	["openai_agents_sdk", "OpenAI Agents SDK"],
	["openinference-openai", "OpenInference · OpenAI"],
	["pydantic_ai", "Pydantic AI"],
	["smolagents", "smolagents"],
	["spring_ai", "Spring AI"],
	["vercel_ai_sdk", "Vercel AI SDK"],
])

export function vendorLabel(vendorId: string): string {
	const known = VENDOR_LABELS.get(vendorId)
	if (known) return known
	return vendorId
		.replace(/^unknown:/, "")
		.split(/[_-]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join(" ")
}

function absoluteTs(startTime: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : new Date(parsed).toLocaleString()
}

interface AgentSessionsListProps {
	sessions: ReadonlyArray<AgentSessionRow>
	/** The request's limit — rows at the cap mean older sessions were cut off. */
	limit: number
}

export function AgentSessionsList({ sessions, limit }: AgentSessionsListProps) {
	if (sessions.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
				<div className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
					<ChatBubbleSparkleIcon className="size-6" />
				</div>
				<p className="text-sm font-medium">No agent sessions yet</p>
				<p className="mt-1.5 max-w-md text-sm text-muted-foreground">
					Trace your AI agents with a supported framework or OpenTelemetry{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">gen_ai</code>{" "}
					spans, and their sessions will show up here.
				</p>
			</div>
		)
	}

	return (
		<div className="@container">
			{sessions.map((session) => {
				const hasErrors = session.errorSpanCount > 0
				const vendor = vendorLabel(session.vendorId)
				const secondary =
					session.vendorVersion && session.vendorVersion !== "0"
						? `${vendor} · v${session.vendorVersion}`
						: vendor
				return (
					<div
						key={session.sessionId}
						className="relative flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left @2xl:gap-4"
					>
						{/* Errored sessions get a left accent so they can be picked out
						    while scanning — same signal as the replays list. */}
						{hasErrors && (
							<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
						)}

						{/* No leading avatar: the replays list uses one because a gradient
						    initial encodes a *person*; an initial for a framework just reads
						    as a counterfeit vendor logo. The framework is named in text. */}

						{/* Identity lane: session id, framework underneath */}
						<div className="min-w-0 flex-1 overflow-hidden">
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate font-mono text-sm font-medium">
									{session.sessionId}
								</span>
								{/* On phones the right-hand lanes are gone, so the timestamp
								    anchors the top-right corner of the stacked row. */}
								<span
									className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
									title={absoluteTs(session.startTime)}
								>
									{formatRelativeTimeOrDate(session.startTime)}
								</span>
							</div>
							<div className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</div>
							{hasErrors && (
								<div className="mt-1.5 flex items-center gap-1.5 @2xl:hidden">
									<SessionBadges session={session} />
								</div>
							)}
						</div>

						{/* Services lane */}
						<div className="hidden w-[11rem] shrink-0 overflow-hidden @2xl:block">
							<span
								className="block truncate text-xs text-muted-foreground"
								title={session.serviceNames.join(", ")}
							>
								{session.serviceNames.join(" · ")}
							</span>
						</div>

						{/* Activity lane: duration + traces/spans */}
						<div className="hidden w-[13.5rem] shrink-0 items-baseline gap-2 overflow-hidden whitespace-nowrap @3xl:flex">
							<span className="font-mono text-[13px] font-semibold tabular-nums">
								{formatSessionDuration(session.durationMs)}
							</span>
							<span className="truncate text-xs text-muted-foreground">
								{session.traceCount} trace{session.traceCount === 1 ? "" : "s"} ·{" "}
								{session.spanCount} span{session.spanCount === 1 ? "" : "s"}
							</span>
						</div>

						{/* Signal lane: error chip */}
						<div className="hidden w-[8.75rem] shrink-0 items-center gap-1.5 overflow-hidden @2xl:flex">
							<SessionBadges session={session} />
						</div>

						{/* Time lane */}
						<div className="hidden shrink-0 items-center @2xl:flex">
							<span
								className="whitespace-nowrap text-xs text-muted-foreground"
								title={absoluteTs(session.startTime)}
							>
								{formatRelativeTimeOrDate(session.startTime)}
							</span>
						</div>
					</div>
				)
			})}

			{sessions.length >= limit && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing the {limit.toLocaleString()} most recent sessions — narrow the time range to see
					older ones
				</p>
			)}
		</div>
	)
}

function SessionBadges({ session }: { session: AgentSessionRow }) {
	if (session.errorSpanCount === 0) return null
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-destructive">
			<span className="size-1 rounded-full bg-destructive" aria-hidden />
			{session.errorSpanCount} error{session.errorSpanCount === 1 ? "" : "s"}
		</span>
	)
}

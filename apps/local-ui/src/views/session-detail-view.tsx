import type { ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CircleWarningIcon,
	ClockIcon,
	CodeIcon,
	ComputerIcon,
	GlobeIcon,
	MobileIcon,
	NetworkNodesIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@maple/ui/format"
import type { SessionTranscriptOutput } from "@maple/query-engine/ch"
import {
	useLocalSessionDetail,
	useLocalSessionTraces,
	useLocalSessionTranscript,
} from "../hooks/use-local-session-detail"
import { formatRelativeTime } from "../lib/time"
import { formatDuration as formatSessionDuration, gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay-format"
import { ErrorState } from "../components/view-states"
import { RefreshButton } from "../components/toolbar"

interface SessionDetailViewProps {
	sessionId: string
	onBack: () => void
	onSelectTrace: (traceId: string) => void
}

export function SessionDetailView({ sessionId, onBack, onSelectTrace }: SessionDetailViewProps) {
	const { data: session, isPending, isError, error } = useLocalSessionDetail(sessionId)
	const traceIds = session?.traceIds ?? []
	const traces = useLocalSessionTraces(traceIds)
	const transcript = useLocalSessionTranscript(sessionId)

	const isActive = session?.status === "active"
	const hasError = (session?.errorCount ?? 0) > 0
	const label = session?.userId || "Anonymous"
	const DeviceIcon = session && isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Sessions
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={sessionId}>
					{sessionId}
				</span>
				<RefreshButton className="ml-auto" />
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : isError ? (
					<ErrorState label="session" error={error} />
				) : !session ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Session not found.
					</div>
				) : (
					<div className="mx-auto max-w-5xl px-4 py-5">
						{/* Hero */}
						<div className="flex flex-wrap items-center gap-4 border-b pb-5">
							<div
								className={`grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} text-base font-semibold text-white shadow-sm`}
							>
								{(label[0] ?? "?").toUpperCase()}
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<h1 className="truncate text-xl font-semibold tracking-tight">{label}</h1>
									<StatusBadge active={isActive} />
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
									<span className="font-mono text-xs">{sessionId.slice(0, 8)}</span>
									<span className="inline-flex items-center gap-1.5">
										<DeviceIcon className="size-3.5 opacity-60" />
										{session.browserName || "Unknown"}
										{session.osName ? ` · ${session.osName}` : ""}
									</span>
									<span className="inline-flex items-center gap-1.5">
										<ClockIcon className="size-3.5 opacity-60" />
										started {formatRelativeTime(session.startTime)}
									</span>
								</div>
							</div>
						</div>

						{/* Stat tiles */}
						<div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
							<StatTile
								label="Duration"
								value={isActive ? "Live" : formatSessionDuration(session.durationMs)}
							/>
							<StatTile label="Page views" value={String(session.pageViews)} />
							<StatTile label="Clicks" value={String(session.clickCount)} />
							<StatTile label="Errors" value={String(session.errorCount)} danger={hasError} />
							<StatTile label="Traces" value={String(traceIds.length)} />
						</div>

						<div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
							<div className="flex flex-col gap-5">
								<Card title="Client">
									<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
										<Field label="User" value={label} />
										<Field label="Browser" value={session.browserName} />
										<Field label="OS" value={session.osName} />
										<Field label="Device" value={session.deviceType} />
										<Field label="Service" value={session.serviceName} />
										<Field
											label="Entry URL"
											value={hostFromUrl(session.urlInitial)}
											title={session.urlInitial}
											className="col-span-2"
										/>
										<Field
											label="User agent"
											value={session.userAgent}
											className="col-span-2"
										/>
									</dl>
								</Card>

								<Card title={`Correlated traces · ${traceIds.length}`}>
									{traceIds.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No backend traces correlated.
										</p>
									) : traces.isPending ? (
										<Spinner className="size-4" />
									) : (
										<ul className="space-y-1.5">
											{(traces.data ?? []).map((trace) => (
												<li key={trace.traceId}>
													<button
														type="button"
														onClick={() => onSelectTrace(trace.traceId)}
														className="group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
													>
														<span
															className={cn(
																"size-1.5 shrink-0 rounded-full",
																trace.hasError
																	? "bg-destructive"
																	: "bg-muted-foreground/40",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-sm">
																{trace.rootSpanName ||
																	trace.traceId.slice(0, 12)}
															</span>
															<span className="block truncate text-xs text-muted-foreground">
																{trace.rootServiceName || "unknown"} ·{" "}
																{trace.spanCount} spans
															</span>
														</span>
														<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
															{formatDuration(trace.durationMs)}
														</span>
														<ArrowRightIcon
															size={14}
															className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
														/>
													</button>
												</li>
											))}
										</ul>
									)}
								</Card>
							</div>

							<Card title="Event transcript">
								{transcript.isPending ? (
									<Spinner className="size-4" />
								) : transcript.isError ? (
									<ErrorState label="transcript" error={transcript.error} />
								) : (transcript.data?.length ?? 0) === 0 ? (
									<p className="text-sm text-muted-foreground">
										No distilled events for this session.
									</p>
								) : (
									<Transcript
										events={transcript.data ?? []}
										startTime={session.startTime}
									/>
								)}
							</Card>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function parseChTime(value: string | null | undefined): number {
	if (!value) return NaN
	return Date.parse(`${value.replace(" ", "T")}Z`)
}

function offsetLabel(startTime: string, ts: string): string {
	const start = parseChTime(startTime)
	const at = parseChTime(ts)
	if (Number.isNaN(start) || Number.isNaN(at)) return ""
	const deltaMs = Math.max(0, at - start)
	if (deltaMs < 1000) return `+${deltaMs}ms`
	return `+${(deltaMs / 1000).toFixed(1)}s`
}

function EventIcon({ event }: { event: SessionTranscriptOutput }) {
	const className = "size-3.5"
	switch (event.type) {
		case "navigation":
			return <GlobeIcon className={className} />
		case "click":
		case "input":
			return <PulseIcon className={className} />
		case "console":
			return <CodeIcon className={className} />
		case "network":
			return <NetworkNodesIcon className={className} />
		case "error":
			return <CircleWarningIcon className={className} />
		default:
			return <CodeIcon className={className} />
	}
}

function isErrorEvent(event: SessionTranscriptOutput): boolean {
	return (
		event.type === "error" ||
		(event.type === "console" && event.level === "error") ||
		(event.type === "network" && event.netStatus >= 400)
	)
}

function Transcript({
	events,
	startTime,
}: {
	events: ReadonlyArray<SessionTranscriptOutput>
	startTime: string
}) {
	return (
		<ol className="space-y-3">
			{events.map((event) => {
				const danger = isErrorEvent(event)
				return (
					<li key={`${event.seq}-${event.timestamp}`} className="flex gap-3">
						<span
							className={cn(
								"mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
								danger
									? "bg-destructive/10 text-destructive"
									: "bg-muted text-muted-foreground",
							)}
						>
							<EventIcon event={event} />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline justify-between gap-2">
								<span className="text-xs font-medium capitalize">{event.type}</span>
								<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
									{offsetLabel(startTime, event.timestamp)}
								</span>
							</div>
							<TranscriptBody event={event} />
						</div>
					</li>
				)
			})}
		</ol>
	)
}

function TranscriptBody({ event }: { event: SessionTranscriptOutput }) {
	switch (event.type) {
		case "navigation":
			return <p className="truncate text-xs text-muted-foreground">{event.url || "—"}</p>
		case "click":
			return (
				<p className="truncate text-xs text-muted-foreground">
					{event.targetText || event.targetSelector || "element"}
				</p>
			)
		case "input":
			return (
				<p className="truncate font-mono text-xs text-muted-foreground">
					{event.targetSelector || "input"}
				</p>
			)
		case "console":
			return <p className="break-words text-xs text-muted-foreground">{event.message}</p>
		case "network":
			return (
				<p className="truncate text-xs text-muted-foreground">
					<span className="font-medium text-foreground">{event.netMethod}</span> {event.netUrl}
					<span className={cn("ml-1.5 tabular-nums", event.netStatus >= 400 && "text-destructive")}>
						{event.netStatus || "—"} · {Math.round(event.netDurationMs)}ms
					</span>
				</p>
			)
		case "error":
			return (
				<div>
					<p className="break-words text-xs text-destructive">{event.message}</p>
					{event.errorStack ? (
						<pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[10px] text-muted-foreground">
							{event.errorStack}
						</pre>
					) : null}
				</div>
			)
		default:
			return <p className="truncate text-xs text-muted-foreground">{event.message}</p>
	}
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function StatusBadge({ active }: { active: boolean }) {
	if (active) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
				<span className="relative flex size-1.5">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
					<span className="relative inline-flex size-1.5 rounded-full bg-success" />
				</span>
				Active
			</span>
		)
	}
	return (
		<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
			Ended
		</span>
	)
}

function StatTile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<div className="rounded-xl border bg-card px-3 py-2.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 text-2xl font-semibold tabular-nums tracking-tight",
					danger && "text-destructive",
				)}
			>
				{value}
			</p>
		</div>
	)
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-xl border bg-card p-4">
			<h2 className="mb-3 text-sm font-medium">{title}</h2>
			{children}
		</section>
	)
}

function Field({
	label,
	value,
	title,
	className,
}: {
	label: string
	value: string
	title?: string
	className?: string
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="truncate" title={title ?? value}>
				{value || "—"}
			</dd>
		</div>
	)
}

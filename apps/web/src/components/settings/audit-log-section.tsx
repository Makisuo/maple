import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import type { V2AuditChanges, V2AuditLogEntry } from "@maple/domain/http/v2"
import { useState, type ReactNode } from "react"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { auditLogPageAtom } from "@/lib/services/atoms/audit-log-atoms"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { AlertWarningIcon, HistoryIcon } from "@/components/icons"

type ActorFilter = AuditActorType | "all"
type OutcomeFilter = AuditOutcome | "all"

const ACTOR_FILTERS: ReadonlyArray<{ value: ActorFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "user", label: "Users" },
	{ value: "api_key", label: "API keys" },
	{ value: "agent", label: "Agents" },
	{ value: "system", label: "System" },
]

const OUTCOME_FILTERS: ReadonlyArray<{ value: OutcomeFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "allowed", label: "Allowed" },
	{ value: "denied", label: "Denied" },
]

const ACTOR_BADGES: Record<AuditActorType, { label: string; variant: "secondary" | "success" | "info" | "outline" }> = {
	user: { label: "User", variant: "secondary" },
	api_key: { label: "API key", variant: "success" },
	agent: { label: "Agent", variant: "info" },
	system: { label: "System", variant: "outline" },
} satisfies Record<AuditActorType, { label: string; variant: "secondary" | "success" | "info" | "outline" }>

// Shared column lanes so the header row and entry rows stay aligned. Resource and
// source collapse on narrower viewports; time + actor + action always stay visible.
const COL = {
	time: "w-[96px] shrink-0",
	actor: "w-[200px] min-w-0 shrink-0",
	action: "min-w-0 flex-1",
	resource: "hidden w-[220px] min-w-0 shrink-0 md:block",
	source: "hidden w-[80px] shrink-0 lg:block",
}
const COL_HEADER = "text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.12em]"

function formatDateTime(value: string): string {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

// JSON.stringify(undefined) is undefined — surface it as text in tooltips.
function formatChangeValue(value: unknown): string {
	return JSON.stringify(value) ?? "undefined"
}

function formatChangesTooltip(changes: V2AuditChanges): string {
	return changes.fields
		.map(
			(field) =>
				`${field}: ${formatChangeValue(changes.before[field])} → ${formatChangeValue(changes.after[field])}`,
		)
		.join("\n")
}

function formatSourceTooltip(entry: V2AuditLogEntry): string | undefined {
	const lines = [
		entry.origin_ip !== null || entry.origin_country !== null
			? `From ${entry.origin_ip ?? "unknown IP"}${entry.origin_country !== null ? ` (${entry.origin_country})` : ""}`
			: null,
		entry.request_id !== null ? `Request ${entry.request_id}` : null,
	].filter((line) => line !== null)
	return lines.length > 0 ? lines.join("\n") : undefined
}

interface AuditLogView {
	source: { data: ReadonlyArray<V2AuditLogEntry> }
	entries: V2AuditLogEntry[]
	hasMore: boolean
	nextCursor: string | null
}

export function AuditLogSection() {
	const [actorFilter, setActorFilter] = useState<ActorFilter>("all")
	const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all")
	const [cursor, setCursor] = useState<string | undefined>(undefined)

	const pageAtom = auditLogPageAtom({
		...(cursor !== undefined ? { cursor } : undefined),
		...(actorFilter !== "all" ? { actorType: actorFilter } : undefined),
		...(outcomeFilter !== "all" ? { outcome: outcomeFilter } : undefined),
	})
	const pageResult = useAtomValue(pageAtom)
	const refreshPage = useAtomRefresh(pageAtom)

	// Each Load more / filter change swaps to a new page atom, which starts in its
	// initial state. Keep the accumulated entries so the table stays rendered
	// (dimmed) while the next page loads; a fresh (cursor-less) page replaces them.
	const [view, setView] = useState<AuditLogView | null>(null)
	if (Result.isSuccess(pageResult) && view?.source !== pageResult.value) {
		setView({
			source: pageResult.value,
			entries:
				cursor === undefined
					? [...pageResult.value.data]
					: [...(view?.entries ?? []), ...pageResult.value.data],
			hasMore: pageResult.value.has_more,
			nextCursor: pageResult.value.next_cursor,
		})
	}

	function handleFilterSelect(value: ActorFilter) {
		if (value === actorFilter) return
		setActorFilter(value)
		setCursor(undefined)
	}

	function handleOutcomeSelect(value: OutcomeFilter) {
		if (value === outcomeFilter) return
		setOutcomeFilter(value)
		setCursor(undefined)
	}

	const waiting = !Result.isSuccess(pageResult) || pageResult.waiting

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<div className="border-border flex items-center gap-0.5 rounded-md border p-0.5">
					{ACTOR_FILTERS.map((filter) => (
						<FilterTab
							key={filter.value}
							active={actorFilter === filter.value}
							onClick={() => handleFilterSelect(filter.value)}
						>
							{filter.label}
						</FilterTab>
					))}
				</div>
				<div className="border-border flex items-center gap-0.5 rounded-md border p-0.5">
					{OUTCOME_FILTERS.map((filter) => (
						<FilterTab
							key={filter.value}
							active={outcomeFilter === filter.value}
							onClick={() => handleOutcomeSelect(filter.value)}
						>
							{filter.label}
						</FilterTab>
					))}
				</div>
				<div className="flex-1" />
				<p className="text-muted-foreground text-xs">
					Every change made through the dashboard, API, and MCP.
				</p>
			</div>

			<div className={cn("bg-card rounded-lg border", waiting && view !== null && "opacity-60")}>
				{view === null && Result.isFailure(pageResult) ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<AlertWarningIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>Couldn't load the audit log</EmptyTitle>
							<EmptyDescription>
								Something went wrong while loading audit log entries.
							</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={() => refreshPage()}>
							Try again
						</Button>
					</Empty>
				) : view === null ? (
					<div className="space-y-2 p-4">
						<Skeleton className="h-[44px] w-full" />
						<Skeleton className="h-[44px] w-full" />
						<Skeleton className="h-[44px] w-full" />
					</div>
				) : view.entries.length === 0 ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No audit log entries</EmptyTitle>
							<EmptyDescription>
								Actions performed by users, API keys, and agents will appear here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="divide-border divide-y">
						<div className="flex items-center gap-3 px-4 py-2">
							<span className={cn(COL_HEADER, COL.time)}>Time</span>
							<span className={cn(COL_HEADER, COL.actor)}>Actor</span>
							<span className={cn(COL_HEADER, COL.action)}>Action</span>
							<span className={cn(COL_HEADER, COL.resource)}>Resource</span>
							<span className={cn(COL_HEADER, COL.source)}>Source</span>
						</div>
						{view.entries.map((entry) => (
							<AuditLogRow key={entry.id} entry={entry} />
						))}
					</div>
				)}
			</div>

			{view !== null && view.hasMore && view.nextCursor !== null && (
				<div className="flex items-center gap-3 text-sm text-muted-foreground">
					<span>Showing {view.entries.length} entries — more available</span>
					<Button
						variant="outline"
						size="sm"
						disabled={waiting}
						onClick={() => {
							if (view.nextCursor !== null) setCursor(view.nextCursor)
						}}
					>
						{waiting ? "Loading…" : "Load more"}
					</Button>
				</div>
			)}
		</div>
	)
}

function FilterTab({
	active,
	onClick,
	children,
}: {
	active: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded px-2.5 py-1 font-mono text-[11px] leading-4 transition-colors",
				active
					? "bg-accent text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}

function AuditLogRow({ entry }: { entry: V2AuditLogEntry }) {
	const badge = ACTOR_BADGES[entry.actor_type]
	const actorLabel = entry.actor_name ?? entry.actor_id ?? "—"

	return (
		<div className="hover:bg-muted/20 flex items-center gap-3 px-4 py-2.5 transition-colors">
			<span
				className={cn(COL.time, "text-muted-foreground text-xs")}
				title={formatDateTime(entry.occurred_at)}
			>
				{formatRelativeTime(entry.occurred_at)}
			</span>
			<div className={cn(COL.actor, "flex items-center gap-1.5")}>
				<Badge variant={badge.variant} size="sm" className="shrink-0">
					{badge.label}
				</Badge>
				<span className="truncate text-xs" title={entry.actor_id ?? undefined}>
					{actorLabel}
				</span>
			</div>
			<div className={cn(COL.action, "min-w-0")}>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="truncate font-mono text-xs" title={entry.action}>
						{entry.action}
					</span>
					{entry.outcome === "denied" && (
						<Badge variant="error" size="sm" className="shrink-0">
							Denied
						</Badge>
					)}
				</div>
				{entry.outcome === "denied" && entry.denial_reason !== null && (
					<p className="text-muted-foreground truncate text-[11px]" title={entry.denial_reason}>
						{entry.denial_reason}
					</p>
				)}
				{entry.changes !== null && entry.changes.fields.length > 0 && (
					<p
						className="text-muted-foreground truncate font-mono text-[11px]"
						title={formatChangesTooltip(entry.changes)}
					>
						{entry.changes.fields.join(", ")}
					</p>
				)}
			</div>
			<div className={cn(COL.resource, "min-w-0")}>
				{entry.resource_type !== null || entry.resource_id !== null ? (
					<div className="flex min-w-0 items-center gap-1.5">
						{entry.resource_type !== null && (
							<Badge variant="outline" size="sm" className="shrink-0">
								{entry.resource_type}
							</Badge>
						)}
						{entry.resource_id !== null && (
							<span
								className="text-muted-foreground truncate font-mono text-[11px]"
								title={entry.resource_id}
							>
								{entry.resource_id}
							</span>
						)}
					</div>
				) : (
					<span className="text-muted-foreground text-xs">—</span>
				)}
			</div>
			<span
				className={cn(COL.source, "text-muted-foreground truncate text-xs")}
				title={formatSourceTooltip(entry)}
			>
				{entry.source}
				{entry.origin_country !== null && (
					<span className="text-muted-foreground/60"> · {entry.origin_country}</span>
				)}
			</span>
		</div>
	)
}

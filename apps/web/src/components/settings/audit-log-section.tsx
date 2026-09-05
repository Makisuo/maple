import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	type V2AuditChanges,
	type V2AuditLogEntry,
} from "@maple/domain/http/v2"
import { Option } from "effect"
import { useState, type ReactNode } from "react"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { auditLogPageAtom } from "@/lib/services/atoms/audit-log-atoms"

import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { trySync } from "@maple/ui/lib/try-sync"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { AlertWarningIcon, ArrowPathIcon, ChevronRightIcon, HistoryIcon } from "@/components/icons"

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
// source collapse when the card is narrow; time + actor + action always stay
// visible, and action is the lane that absorbs the remaining width. The card,
// not the viewport, is what the breakpoints measure: the sidebar and settings
// nav leave it far narrower than the window.
// Below `@md` a row wraps: time + actor on the first line, the action on its own
// line beneath, indented past the chevron.
const COL = {
	time: "flex w-[112px] shrink-0 items-center gap-2",
	actor: "min-w-0 flex-1 @md:w-[176px] @md:flex-none",
	action: "min-w-0 basis-full pl-5 @md:basis-0 @md:flex-1 @md:pl-0",
	resource: "hidden w-[200px] min-w-0 shrink-0 @3xl:block",
	// 52rem: the card's width at a 1440px window, the narrowest desktop that should still show it.
	source: "hidden w-[104px] shrink-0 @min-[52rem]:block",
}
const COL_HEADER = "text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.12em]"

/**
 * Up to two initials from a display name, for the moment before the avatar
 * loads and for the members Clerk serves no picture for. An email falls back to
 * its first letter rather than parsing a local part that is rarely a name.
 */
function initialsOf(label: string): string {
	// A row we could not name falls back to the raw `user_…` id; "U" would read
	// as a name it is not.
	if (label.startsWith("user_")) return "?"
	const words = label.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0 || label.includes("@")) return label.slice(0, 1).toUpperCase()
	return words
		.slice(0, 2)
		.map((word) => word.slice(0, 1).toUpperCase())
		.join("")
}

/**
 * `user_3BfcmIS3bUNV6BfAEkR2WzFOCvu` → `user_…FOCvu`. The prefix says what kind
 * of id it is and the tail is what someone compares against a copied value;
 * the middle is noise in a 200px lane. The full id stays in the detail panel.
 */
function abbreviateId(id: string): string {
	const prefixEnd = id.indexOf("_")
	if (prefixEnd === -1 || id.length <= prefixEnd + 10) return id
	return `${id.slice(0, prefixEnd + 1)}…${id.slice(-5)}`
}

function actorDisplayName(entry: V2AuditLogEntry): string | null {
	if (entry.actor_name !== null) return entry.actor_name
	if (entry.actor_id !== null) return abbreviateId(entry.actor_id)
	return null
}

function formatDateTime(value: string): string {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

function formatDateTimeFull(value: string): string {
	return new Date(value).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	})
}

/** `<redacted>` / `<updated>` are the audit pipeline's placeholders, not values. */
function isPlaceholder(value: unknown): value is string {
	return typeof value === "string" && /^<[a-z]+>$/.test(value)
}

// JSON.stringify(undefined) is undefined — surface it as text.
function formatScalar(value: unknown): string {
	if (typeof value === "string") return value
	return JSON.stringify(value) ?? "undefined"
}

/** What a metadata string that opens with `{` or `[` parses to, when it parses at all. */
type JsonDocument = Record<string, unknown> | ReadonlyArray<unknown>

/**
 * Metadata values are stored as they were recorded: request bodies and tool
 * parameters arrive as JSON text, SQL as a statement. Anything structured, or
 * long enough to wrap, is rendered as a block rather than inline.
 */
function metadataBlock(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim()
		const parsed =
			trimmed.startsWith("{") || trimmed.startsWith("[")
				? Option.getOrNull(trySync((): JsonDocument => JSON.parse(trimmed)))
				: null
		if (parsed !== null) return JSON.stringify(parsed, null, 2)
		return value.length > 72 || value.includes("\n") ? value : null
	}
	if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2)
	return null
}

/**
 * Append the next page, dropping any entry already shown. The pinned `until`
 * ceiling makes overlap rare, but a filter re-fetch or a refresh mid-scroll can
 * still repeat one — and a duplicated React key corrupts the list either way.
 */
function dedupeById(
	existing: ReadonlyArray<V2AuditLogEntry>,
	next: ReadonlyArray<V2AuditLogEntry>,
): V2AuditLogEntry[] {
	const seen = new Set(existing.map((entry) => entry.id))
	return [...existing, ...next.filter((entry) => !seen.has(entry.id))]
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
	// Frozen on the first Load more, and cleared whenever the list restarts. The
	// log is append-only and paginated by offset, so entries written mid-scroll
	// would otherwise shift later pages and make them repeat and skip rows.
	const [until, setUntil] = useState<string | undefined>(undefined)

	const filterInput = {
		...(actorFilter !== "all" ? { actorType: actorFilter } : undefined),
		...(outcomeFilter !== "all" ? { outcome: outcomeFilter } : undefined),
	}
	const pageAtom = auditLogPageAtom({
		...filterInput,
		...(cursor !== undefined ? { cursor } : undefined),
		...(until !== undefined ? { until } : undefined),
	})
	// The first page for the current filters — what Refresh re-fetches. Without
	// the refresh the page family would hand back its cached copy from before.
	const firstPageAtom = auditLogPageAtom(filterInput)
	const pageResult = useAtomValue(pageAtom)
	const refreshPage = useAtomRefresh(pageAtom)
	const refreshFirstPage = useAtomRefresh(firstPageAtom)

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
					: dedupeById(view?.entries ?? [], pageResult.value.data),
			hasMore: pageResult.value.has_more,
			nextCursor: pageResult.value.next_cursor,
		})
	}

	function restartList() {
		setCursor(undefined)
		setUntil(undefined)
	}

	function handleFilterSelect(value: ActorFilter) {
		if (value === actorFilter) return
		setActorFilter(value)
		restartList()
	}

	function handleOutcomeSelect(value: OutcomeFilter) {
		if (value === outcomeFilter) return
		setOutcomeFilter(value)
		restartList()
	}

	function clearFilters() {
		setActorFilter("all")
		setOutcomeFilter("all")
		restartList()
	}

	function handleRefresh() {
		restartList()
		refreshFirstPage()
	}

	const waiting = !Result.isSuccess(pageResult) || pageResult.waiting
	const filtered = actorFilter !== "all" || outcomeFilter !== "all"

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-xs">
				Changes, refused attempts, and every read of telemetry or session replays — from the dashboard,
				API, and MCP. Select an entry for its full record.
			</p>

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
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="Refresh audit log"
					title="Refresh"
					disabled={waiting}
					onClick={handleRefresh}
				>
					<ArrowPathIcon size={14} />
				</Button>
			</div>

			<div
				className={cn(
					"@container bg-card rounded-lg border",
					waiting && view !== null && "opacity-60",
				)}
			>
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
				) : view.entries.length === 0 && filtered ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No entries match these filters</EmptyTitle>
							<EmptyDescription>
								Nothing recorded for this actor type and outcome.
							</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={clearFilters}>
							Clear filters
						</Button>
					</Empty>
				) : view.entries.length === 0 ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No audit log entries</EmptyTitle>
							<EmptyDescription>
								Actions and data reads by users, API keys, and agents will appear here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="divide-border divide-y">
						<div className="hidden items-center gap-3 px-4 py-2 @md:flex" aria-hidden="true">
							<span className={cn(COL_HEADER, COL.time)}>
								{/* Holds the chevron's lane so "Time" sits over the timestamps. */}
								<span className="w-3 shrink-0" />
								Time
							</span>
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
							if (view.nextCursor === null) return
							// Pin the window to the newest entry already on screen before
							// the first Load more, so later offsets address a list that
							// cannot grow underneath them.
							if (until === undefined) {
								const newest = view.entries[0]
								if (newest !== undefined) setUntil(newest.occurred_at)
							}
							setCursor(view.nextCursor)
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
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"rounded px-2.5 py-1 font-mono text-[11px] leading-4 transition-colors",
				"focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1",
				active
					? "bg-accent text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}

function ActorCell({ entry }: { entry: V2AuditLogEntry }) {
	const badge = ACTOR_BADGES[entry.actor_type]
	const name = actorDisplayName(entry)

	return (
		<div className={cn(COL.actor, "flex items-center gap-1.5")}>
			{/* A person is shown as a face, not as the word "User" — the avatar
			    already says which kind of actor this is, and the name says who.
			    Keys, agents and system entries have no face and keep their badge.
			    The face is never lent to a key or an agent: those rows carry the
			    minting user's id too, and wearing it would credit a human for
			    something they may not have done. */}
			{entry.actor_type === "user" ? (
				<Avatar className="size-4 shrink-0 text-[9px]">
					{entry.actor_avatar_url !== null && <AvatarImage src={entry.actor_avatar_url} alt="" />}
					<AvatarFallback>{initialsOf(entry.actor_name ?? entry.actor_id ?? "")}</AvatarFallback>
				</Avatar>
			) : (
				<Badge variant={badge.variant} size="sm" className="shrink-0">
					{badge.label}
				</Badge>
			)}
			{name !== null && (
				<span
					className={cn("truncate text-xs", entry.actor_name === null && "text-muted-foreground")}
					title={entry.actor_id ?? undefined}
				>
					{name}
				</span>
			)}
		</div>
	)
}

/** `alert_rule.updated` with the verb carrying the weight — it is what a scan of the column is for. */
function ActionLabel({ action }: { action: string }) {
	const dot = action.indexOf(".")
	if (dot === -1) return <span className="truncate font-mono text-xs">{action}</span>
	return (
		<span className="truncate font-mono text-xs" title={action}>
			<span className="text-muted-foreground">{action.slice(0, dot + 1)}</span>
			<span className="text-foreground">{action.slice(dot + 1)}</span>
		</span>
	)
}

function AuditLogRow({ entry }: { entry: V2AuditLogEntry }) {
	const [expanded, setExpanded] = useState(false)
	const detailId = `audit-entry-${entry.id}`
	const denied = entry.outcome === "denied"

	return (
		<div className={cn(expanded && "bg-muted/10")}>
			<button
				type="button"
				aria-expanded={expanded}
				aria-controls={detailId}
				onClick={() => setExpanded((open) => !open)}
				className={cn(
					"hover:bg-muted/20 flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors @md:flex-nowrap",
					"focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset",
				)}
			>
				<span className={cn(COL.time, "text-muted-foreground text-xs")}>
					<ChevronRightIcon
						size={12}
						className={cn(
							"text-muted-foreground/60 shrink-0 transition-transform",
							expanded && "rotate-90",
						)}
					/>
					<span title={formatDateTime(entry.occurred_at)}>{formatRelativeTime(entry.occurred_at)}</span>
				</span>
				<ActorCell entry={entry} />
				<div className={cn(COL.action, "min-w-0")}>
					<div className="flex min-w-0 items-center gap-1.5">
						<ActionLabel action={entry.action} />
						{denied && (
							<Badge variant="error" size="sm" className="shrink-0">
								Denied
							</Badge>
						)}
					</div>
					{denied && entry.denial_reason !== null && (
						<p className="text-muted-foreground truncate text-[11px]" title={entry.denial_reason}>
							{entry.denial_reason}
						</p>
					)}
					{entry.changes !== null && entry.changes.fields.length > 0 && (
						<p className="text-muted-foreground truncate font-mono text-[11px]">
							{entry.changes.fields.join(", ")}
						</p>
					)}
				</div>
				<div className={cn(COL.resource, "min-w-0")}>
					<ResourceCell entry={entry} />
				</div>
				<span className={cn(COL.source, "text-muted-foreground truncate text-xs")}>
					{entry.source}
					{entry.origin_country !== null && (
						<span className="text-muted-foreground/60"> · {entry.origin_country}</span>
					)}
				</span>
			</button>
			{expanded && (
				<div id={detailId}>
					<AuditLogDetail entry={entry} />
				</div>
			)}
		</div>
	)
}

function ResourceCell({ entry }: { entry: V2AuditLogEntry }) {
	// Membership changes act on a person: the affected user is the resource.
	const id = entry.resource_id ?? entry.affected_user
	if (entry.resource_type === null && id === null) {
		return <span className="text-muted-foreground text-xs">—</span>
	}
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			{entry.resource_type !== null && (
				<Badge variant="outline" size="sm" className="shrink-0">
					{entry.resource_type}
				</Badge>
			)}
			{id !== null && (
				<span className="text-muted-foreground truncate font-mono text-[11px]" title={id}>
					{id}
				</span>
			)}
		</div>
	)
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className={cn(COL_HEADER, "pt-0.5")}>{label}</dt>
			<dd className="min-w-0 text-xs">{children}</dd>
		</>
	)
}

/** An identifier with its copy affordance; the one place the full value is shown untruncated. */
function Identifier({ value, label }: { value: string; label: string }) {
	return (
		<span className="inline-flex max-w-full items-center gap-0.5">
			<code className="truncate font-mono text-[11px]">{value}</code>
			<CopyButton value={value} label={label} toast={false} iconSize={12} className="size-5" />
		</span>
	)
}

function ChangeValue({ value }: { value: unknown }) {
	if (isPlaceholder(value)) {
		return <span className="text-muted-foreground/70 italic">{value.slice(1, -1)}</span>
	}
	if (value === undefined || value === null || value === "") {
		return <span className="text-muted-foreground/60">—</span>
	}
	return <span className="break-all">{formatScalar(value)}</span>
}

function ChangesTable({ changes }: { changes: V2AuditChanges }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full font-mono text-[11px]">
				<thead>
					<tr className={cn(COL_HEADER, "text-left")}>
						<th className="w-[160px] pb-1 font-normal">Field</th>
						<th className="pb-1 font-normal">Before</th>
						<th className="pb-1 font-normal">After</th>
					</tr>
				</thead>
				<tbody className="align-top">
					{changes.fields.map((field) => (
						<tr key={field} className="border-border/60 border-t">
							<td className="text-muted-foreground py-1 pr-3">{field}</td>
							<td className="py-1 pr-3">
								<ChangeValue value={changes.before[field]} />
							</td>
							<td className="py-1">
								<ChangeValue value={changes.after[field]} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function MetadataList({ metadata }: { metadata: Record<string, unknown> }) {
	const keys = Object.keys(metadata)
	if (keys.length === 0) return null
	return (
		<dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
			{keys.map((key) => {
				const value = metadata[key]
				const block = metadataBlock(value)
				return (
					<DetailField key={key} label={key}>
						{block !== null ? (
							<pre className="bg-background/60 max-h-64 overflow-auto rounded-md border px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
								{block}
							</pre>
						) : (
							<span className="font-mono text-[11px] break-all">
								<ChangeValue value={value} />
							</span>
						)}
					</DetailField>
				)
			})}
		</dl>
	)
}

function AuditLogDetail({ entry }: { entry: V2AuditLogEntry }) {
	const badge = ACTOR_BADGES[entry.actor_type]
	const hasChanges = entry.changes !== null && entry.changes.fields.length > 0
	const hasMetadata = entry.metadata !== null && Object.keys(entry.metadata).length > 0

	return (
		<div className="border-border/60 space-y-4 border-t px-4 py-3 @md:pl-[44px]">
			<dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 @3xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)] @3xl:gap-x-6">
				<DetailField label="Occurred">
					<span className="tabular-nums">{formatDateTimeFull(entry.occurred_at)}</span>
				</DetailField>
				<DetailField label="Recorded">
					<span className="tabular-nums">{formatDateTimeFull(entry.recorded_at)}</span>
				</DetailField>
				<DetailField label="Actor">
					<span className="flex min-w-0 flex-wrap items-center gap-1.5">
						<Badge variant={badge.variant} size="sm">
							{badge.label}
						</Badge>
						{entry.actor_name !== null && <span>{entry.actor_name}</span>}
						{entry.actor_id !== null && <Identifier value={entry.actor_id} label="Actor id" />}
					</span>
				</DetailField>
				<DetailField label="Source">
					<span>{entry.source}</span>
					{(entry.origin_ip !== null || entry.origin_country !== null) && (
						<span className="text-muted-foreground">
							{" · "}
							{entry.origin_ip ?? "unknown IP"}
							{entry.origin_country !== null && ` (${entry.origin_country})`}
						</span>
					)}
				</DetailField>
				<DetailField label="Action">
					<span className="flex flex-wrap items-center gap-1.5">
						<code className="font-mono text-[11px]">{entry.action}</code>
						{entry.outcome === "denied" ? (
							<Badge variant="error" size="sm">
								Denied
							</Badge>
						) : (
							<Badge variant="success" size="sm">
								Allowed
							</Badge>
						)}
					</span>
					{entry.denial_reason !== null && (
						<p className="text-muted-foreground mt-0.5">{entry.denial_reason}</p>
					)}
				</DetailField>
				<DetailField label="Resource">
					{entry.resource_type === null && entry.resource_id === null ? (
						<span className="text-muted-foreground/60">—</span>
					) : (
						<span className="flex min-w-0 flex-wrap items-center gap-1.5">
							{entry.resource_type !== null && (
								<Badge variant="outline" size="sm">
									{entry.resource_type}
								</Badge>
							)}
							{entry.resource_id !== null && (
								<Identifier value={entry.resource_id} label="Resource id" />
							)}
						</span>
					)}
				</DetailField>
				{entry.affected_user !== null && (
					<DetailField label="Affected user">
						<Identifier value={entry.affected_user} label="Affected user id" />
					</DetailField>
				)}
				{entry.request_id !== null && (
					<DetailField label="Request">
						<Identifier value={entry.request_id} label="Request id" />
					</DetailField>
				)}
				<DetailField label="Entry">
					{/* The wire codec hands the client the raw id; show the `alog_…`
					    form the API itself returns, so it can be quoted back to it. */}
					<Identifier value={encodePublicId(PublicIdPrefixes.auditLogEntry, entry.id)} label="Entry id" />
				</DetailField>
			</dl>

			{hasChanges && entry.changes !== null && (
				<section className="space-y-1.5">
					<h4 className={COL_HEADER}>Changes</h4>
					<ChangesTable changes={entry.changes} />
				</section>
			)}

			{hasMetadata && entry.metadata !== null && (
				<section className="space-y-1.5">
					<h4 className={COL_HEADER}>Details</h4>
					<MetadataList metadata={entry.metadata} />
				</section>
			)}
		</div>
	)
}

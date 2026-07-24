import type { ReactNode } from "react"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	ClockIcon,
	CircleWarningIcon,
	ComputerIcon,
	EyeIcon,
	GlobeIcon,
	MobileIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import type { SessionReplaysListOutput } from "@maple/query-engine/ch"
import { useLocalSessions, useLocalSessionFacets } from "../hooks/use-local-sessions"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { formatDuration as formatSessionDuration, gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay-format"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@maple/ui/components/filters/filter-section"
import { FilterSidebarBody, FilterSidebarFrame, FilterSidebarHeader } from "@maple/ui/components/filters/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarSearch, ToolbarStat, TimeRangeSelect, RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface SessionsListViewProps {
	onSelectSession: (sessionId: string) => void
}

/** Re-inject a selected value that the server-side facet branch excluded. */
function withSelected(options: ReadonlyArray<FilterOption>, selected?: string): FilterOption[] {
	const list = options.map((o) => ({ name: o.name, count: o.count }))
	if (selected && !list.some((o) => o.name === selected)) list.unshift({ name: selected, count: 0 })
	return list
}

export function SessionsListView({ onSelectSession }: SessionsListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const browser = query.get("browser") || undefined
	const device = query.get("device") || undefined
	const errorsOnly = query.get("errors") === "1"
	const search = query.get("q") || undefined

	const filters = { service, browser, device, errorsOnly, search, range }
	const facets = useLocalSessionFacets(filters)
	const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalSessions(filters)
	const sessions = data?.pages.flat() ?? []

	const setSingle = (key: string, vals: string[]) => setParams({ [key]: vals.at(-1) ?? null })
	const hasActiveFilters = !!service || !!browser || !!device || errorsOnly
	const facetData = facets.data

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, browser: null, device: null, errors: null })}
			/>
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Has errors"
					checked={errorsOnly}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
					count={facetData?.errorCount}
				/>
				{facetData && facetData.service.length > 0 && (
					<>
						<Separator className="my-2" />
						<SearchableFilterSection
							title="Service"
							options={withSelected(facetData.service, service)}
							selected={service ? [service] : []}
							onChange={(vals) => setSingle("service", vals)}
						/>
					</>
				)}
				{facetData && facetData.browser.length > 0 && (
					<>
						<Separator className="my-2" />
						<SearchableFilterSection
							title="Browser"
							options={withSelected(facetData.browser, browser)}
							selected={browser ? [browser] : []}
							onChange={(vals) => setSingle("browser", vals)}
						/>
					</>
				)}
				{facetData && facetData.device.length > 0 && (
					<>
						<Separator className="my-2" />
						<FilterSection
							title="Device"
							options={withSelected(facetData.device, device)}
							selected={device ? [device] : []}
							onChange={(vals) => setSingle("device", vals)}
						/>
					</>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar
			search={
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder="Search by URL…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={sessions.length} label={hasNextPage ? "sessions+" : "sessions"} />
					<ToolbarStat
						value={sessions.filter((s) => s.status === "active").length}
						label="active"
						dot
					/>
					<ToolbarStat value={facetData?.errorCount ?? 0} label="with errors" danger />
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : isError ? (
				<ErrorState label="sessions" error={error} onRetry={() => refetch()} />
			) : sessions.length === 0 ? (
				<EmptyState
					icon={<EyeIcon />}
					title={hasActiveFilters || search ? "No matching sessions" : "No sessions recorded yet"}
					hint={
						hasActiveFilters || search ? (
							"Try widening the time range or clearing filters."
						) : (
							<>
								Install{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
									@maple-dev/browser
								</code>{" "}
								and call{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
									MapleBrowser.init()
								</code>{" "}
								to start capturing sessions.
							</>
						)
					}
				/>
			) : (
				<div className="p-4">
					<div className="space-y-2">
						{sessions.map((session) => (
							<SessionCard
								key={session.sessionId}
								session={session}
								onSelect={() => onSelectSession(session.sessionId)}
							/>
						))}
					</div>
					{hasNextPage ? (
						<div className="flex justify-center pt-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
							</Button>
						</div>
					) : null}
				</div>
			)}
		</PageShell>
	)
}

function SessionCard({ session, onSelect }: { session: SessionReplaysListOutput; onSelect: () => void }) {
	const label = session.userId || "Anonymous"
	const initial = (label[0] ?? "?").toUpperCase()
	const isActive = session.status === "active"
	const DeviceIcon = isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon

	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div
				className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(session.sessionId)} text-sm font-semibold text-white shadow-sm`}
			>
				{initial}
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="max-w-[16rem] truncate text-sm font-medium">{label}</span>
					<StatusDot active={isActive} />
					<span className="font-mono text-xs text-muted-foreground">
						{session.sessionId.slice(0, 8)} · {formatSessionDuration(session.durationMs)}
					</span>
				</div>
				<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
					<span className="flex min-w-0 items-center gap-1.5">
						<GlobeIcon className="size-3.5 shrink-0 opacity-60" />
						<span className="max-w-[18rem] truncate">{hostFromUrl(session.urlInitial)}</span>
					</span>
					<span className="hidden items-center gap-1.5 sm:flex">
						<DeviceIcon className="size-3.5 shrink-0 opacity-60" />
						<span className="truncate">
							{session.browserName || "Unknown"}
							{session.osName ? ` · ${session.osName}` : ""}
						</span>
					</span>
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground">
				<Stat icon={<PulseIcon className="size-3.5" />} value={session.clickCount} title="clicks" />
				<Stat
					icon={<EyeIcon className="size-3.5" />}
					value={session.pageViews || 1}
					title="page views"
				/>
				{session.traceCount > 0 && (
					<span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium tabular-nums text-primary">
						{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
					</span>
				)}
				{session.errorCount > 0 && (
					<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium tabular-nums text-destructive">
						<CircleWarningIcon className="size-3" />
						{session.errorCount}
					</span>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-3">
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
					<ClockIcon className="size-3.5 opacity-60" />
					{formatRelativeTime(session.startTime)}
				</span>
				<span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100">
					<PlayGlyph />
				</span>
			</div>
		</button>
	)
}

function StatusDot({ active }: { active: boolean }) {
	if (!active) return <span className="size-1.5 rounded-full bg-muted-foreground/40" title="ended" />
	return (
		<span className="relative flex size-1.5" title="active">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-success" />
		</span>
	)
}

function Stat({ icon, value, title }: { icon: ReactNode; value: number; title: string }) {
	return (
		<span className="inline-flex items-center gap-1 tabular-nums" title={title}>
			<span className="opacity-60">{icon}</span>
			{value}
		</span>
	)
}

function PlayGlyph() {
	return (
		<svg viewBox="0 0 24 24" className="size-3.5 translate-x-px fill-current" aria-hidden>
			<path d="M8 5v14l11-7z" />
		</svg>
	)
}

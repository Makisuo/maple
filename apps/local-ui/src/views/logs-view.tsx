import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { CodeIcon } from "@maple/ui/components/icons"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Separator } from "@maple/ui/components/ui/separator"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { useLocalLogs, useLocalLogSeverities } from "../hooks/use-local-logs"
import { useLocalServices } from "../hooks/use-local-services"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { normalizeLog, type LocalLog } from "../lib/log-shape"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { FilterSection, SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import { FilterSidebarBody, FilterSidebarFrame, FilterSidebarHeader } from "@maple/ui/components/filters/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarSearch, ToolbarStat, TimeRangeSelect, RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

const ROW_HEIGHT = 36
const VISIBLE_CHIPS = 4

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const severity = query.get("severity") || undefined
	const search = query.get("q") || undefined

	const services = useLocalServices(range)
	const severities = useLocalLogSeverities(range)
	const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalLogs({ service, severity, search, range })

	const rows = useMemo<ReadonlyArray<LocalLog>>(() => (data?.pages.flat() ?? []).map(normalizeLog), [data])
	const scrollRef = useRef<HTMLDivElement>(null)

	const [selectedLog, setSelectedLog] = useState<LocalLog | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	})

	const virtualItems = virtualizer.getVirtualItems()
	useEffect(() => {
		const last = virtualItems[virtualItems.length - 1]
		if (!last) return
		if (last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	const openLog = (log: LocalLog) => {
		setSelectedLog(log)
		setSheetOpen(true)
	}

	const hasActiveFilters = !!service || !!severity

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={services.isFetching || severities.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, severity: null })}
			/>
			<FilterSidebarBody>
				{(severities.data?.length ?? 0) > 0 && (
					<FilterSection
						title="Severity"
						options={(severities.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
						selected={severity ? [severity] : []}
						onChange={(vals) => setParams({ severity: vals.at(-1) ?? null })}
					/>
				)}
				{(services.data?.length ?? 0) > 0 && (
					<>
						<Separator className="my-2" />
						<SearchableFilterSection
							title="Service"
							options={(services.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
							selected={service ? [service] : []}
							onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
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
					placeholder="Search log bodies…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={rows.length} label={hasNextPage ? "logs+" : "logs"} />
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{isPending ? (
				<ListSkeleton variant="table" />
			) : isError ? (
				<ErrorState label="logs" error={error} onRetry={() => refetch()} />
			) : rows.length === 0 ? (
				<EmptyState
					icon={<CodeIcon />}
					title={hasActiveFilters || search ? "No matching logs" : "No logs yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Send OTLP logs to the local ingest endpoint to get started."
					}
				/>
			) : (
				<div ref={scrollRef} className="h-full overflow-auto">
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{virtualItems.map((virtualRow) => {
							const log = rows[virtualRow.index]
							return (
								<LogRow
									key={virtualRow.key}
									log={log}
									top={virtualRow.start}
									height={virtualRow.size}
									selected={selectedLog === log}
									onClick={openLog}
								/>
							)
						})}
					</div>
					{isFetchingNextPage ? (
						<div className="flex justify-center p-3">
							<Spinner className="size-4" />
						</div>
					) : null}
				</div>
			)}

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</PageShell>
	)
}

function LogRow({
	log,
	top,
	height,
	selected,
	onClick,
}: {
	log: LocalLog
	top: number
	height: number
	selected: boolean
	onClick: (log: LocalLog) => void
}) {
	const chips = useMemo(() => pickImportantAttributes(log, VISIBLE_CHIPS), [log])
	const severityColor = getSeverityColor(log.severityText)

	return (
		<div
			data-selected={selected || undefined}
			style={{
				position: "absolute",
				insetInline: 0,
				top: 0,
				transform: `translateY(${top}px)`,
				height,
				borderLeftWidth: "3px",
				borderLeftColor: severityColor,
			}}
			className="flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs hover:bg-muted/50 data-[selected]:bg-primary/5"
			tabIndex={0}
			role="listitem"
			onClick={() => onClick(log)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onClick(log)
				}
			}}
		>
			<span
				className="hidden w-12 shrink-0 text-[10px] font-semibold uppercase tabular-nums md:inline-block"
				style={{ color: severityColor }}
			>
				{log.severityText}
			</span>
			<span className="w-44 shrink-0 text-muted-foreground tabular-nums">{log.timestamp}</span>
			<span
				className="hidden w-36 shrink-0 truncate text-muted-foreground/70 md:inline-block"
				title={log.serviceName}
			>
				{log.serviceName}
			</span>
			<span className="min-w-0 flex-1 truncate" title={log.body}>
				{log.body}
			</span>
			{chips.length > 0 && (
				<div className="hidden min-w-0 max-w-[45%] shrink items-center gap-1 overflow-hidden md:flex">
					{chips.map((chip) => (
						<LogAttributeChip
							key={chip.key}
							attrKey={chip.key}
							value={chip.value}
							tone={chip.tone}
						/>
					))}
				</div>
			)}
		</div>
	)
}

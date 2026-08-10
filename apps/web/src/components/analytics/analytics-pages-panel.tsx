import { useDeferredValue, useMemo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import { ColumnHead, DataTable, useTableSort } from "../infra/primitives/data-table"
import { shareTint } from "../infra/primitives/share-tint"
import type { WebAnalyticsPage } from "@/api/warehouse/web-analytics"
import { Favicon } from "./row-icon"

type SortKey = "pagePath" | "host" | "pageViews" | "sessions"

interface AnalyticsPagesPanelProps {
	pages: ReadonlyArray<WebAnalyticsPage>
	selectedPath?: string
	onTogglePath: (pagePath: string) => void
	waiting?: boolean
	/**
	 * True once more than one site appears. Not merely cosmetic: several sites can
	 * share a path (`/editor/`, `/settings`), and then the host is the only thing
	 * telling those rows apart — so the column is never breakpoint-hidden when
	 * this is on.
	 */
	showHost?: boolean
}

/**
 * Most-viewed pages.
 *
 * The one panel on this page with full coverage: it reads `session_events`
 * navigation rows, which every SDK build emits, so its page-view counts describe
 * all traffic rather than the analytics-block subset the visitor-level panels
 * measure. `pageViews` is a real per-view count; `sessions` is how many distinct
 * sessions reached the page.
 */
export function AnalyticsPagesPanel({
	pages,
	selectedPath,
	onTogglePath,
	waiting,
	showHost,
}: AnalyticsPagesPanelProps) {
	const [query, setQuery] = useState("")
	const deferredQuery = useDeferredValue(query)

	const rows = useMemo(() => {
		const total = pages.reduce((sum, page) => sum + page.pageViews, 0)
		const needle = deferredQuery.trim().toLowerCase()
		return pages
			.filter((page) =>
				needle
					? page.pagePath.toLowerCase().includes(needle) || page.host.toLowerCase().includes(needle)
					: true,
			)
			.map((page) => ({ ...page, share: total > 0 ? page.pageViews / total : 0 }))
	}, [pages, deferredQuery])

	const { sorted, sortKey, sortDir, handleSort } = useTableSort(rows, {
		initialKey: "pageViews" as SortKey,
		stringKeys: ["pagePath", "host"],
	})

	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2">
				<span className="text-[11px] font-medium text-muted-foreground">Top pages</span>
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Filter pages"
					className="h-6 w-40 rounded-sm border bg-background px-2 text-[11px] placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
			</div>

			{pages.length === 0 ? (
				<div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
					No page views in the selected window.
				</div>
			) : (
				<DataTable.Root
					ariaLabel="Top pages"
					waiting={waiting}
					maxHeight={420}
					stickySurfaceClass="bg-card"
				>
					<DataTable.Head>
						<ColumnHead<SortKey>
							label="Page"
							width="flex-1 min-w-0"
							sortKey="pagePath"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						{showHost ? (
							<ColumnHead<SortKey>
								label="Site"
								width="w-32 sm:w-40"
								sortKey="host"
								currentKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
						) : null}
						<ColumnHead<SortKey>
							label="Views"
							width="w-20"
							align="right"
							sortKey="pageViews"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						<ColumnHead<SortKey>
							label="Sessions"
							width="w-24"
							align="right"
							sortKey="sessions"
							currentKey={sortKey}
							dir={sortDir}
							onSort={handleSort}
						/>
						<ColumnHead<SortKey> label="Share" width="w-16" align="right" />
					</DataTable.Head>
					{sorted.length === 0 ? (
						<DataTable.Empty>No page matches that filter.</DataTable.Empty>
					) : (
						sorted.map((row) => {
							const isSelected = selectedPath === row.pagePath
							return (
								<button
									key={`${row.host}${row.pagePath}`}
									type="button"
									onClick={() => onTogglePath(row.pagePath)}
									aria-pressed={isSelected}
									style={{ backgroundImage: shareTint(row.share) }}
									className={cn(
										"flex w-full items-center gap-4 border-b border-border/40 px-4 py-2 text-left transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
										isSelected && "bg-primary/10",
									)}
								>
									<span
										className={cn(
											"min-w-0 flex-1 truncate font-mono text-[12px]",
											isSelected ? "font-medium text-foreground" : "text-foreground/90",
										)}
										title={`${row.host}${row.pagePath}`}
									>
										{row.pagePath}
									</span>
									{showHost ? (
										<span className="flex w-32 items-center gap-1.5 text-[11px] text-muted-foreground sm:w-40">
											<Favicon host={row.host} />
											<span className="truncate">{row.host}</span>
										</span>
									) : null}
									<span className="w-20 text-right font-mono text-[11px] tabular-nums">
										{formatNumber(row.pageViews)}
									</span>
									<span className="w-24 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
										{formatNumber(row.sessions)}
									</span>
									<span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
										{formatPercent(row.share)}
									</span>
								</button>
							)
						})
					)}
				</DataTable.Root>
			)}

			<div className="px-4 py-2 text-[10px] text-muted-foreground/80">
				Page views across every session, including those whose SDK build predates the visitor-level
				analytics fields.
			</div>
		</div>
	)
}

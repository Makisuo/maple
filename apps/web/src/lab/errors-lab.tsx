import { useMemo, useState } from "react"

import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
	ErrorsHubView,
	type HubSort,
	type HubView,
	type SeverityFilter,
	viewCovers,
} from "@/components/errors/errors-hub-view"
import { buildErrorsLabFixture } from "@/lab/errors-fixture"

/**
 * `/errors` without a warehouse behind it.
 *
 * The page it renders is the real one — `ErrorsHubView` is what the route
 * mounts — over a fixture that holds every row state at once: a surging
 * critical with an open incident, a live investigation, a diagnosed one, a
 * message long enough to truncate, an issue that has gone quiet in the window,
 * an unset severity, an alert-kind issue with no sparkline to draw.
 *
 * Getting all of that onto the real page means finding an org that happens to
 * be erroring in twelve different ways, which is why the list was mostly
 * designed against three rows of `TypeError`.
 *
 * The row context menu still calls the live mutation endpoints; without a
 * session those fail and toast. Everything else is local state.
 */

/** Widths worth checking, because the row's lanes are container queries: the
 *  sparkline drops below `@lg`, the count and activity below `@xl`, the status
 *  chip below `@2xl`. */
const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
	{ label: "600px", value: 600 },
] as const

const STATES = ["ready", "loading", "failed", "empty"] as const
type LabState = (typeof STATES)[number]

export function ErrorsLab() {
	// One timestamp for the life of the mount: "3m ago" that ticks while you are
	// looking at a spacing change is noise.
	const [nowMs] = useState(() => Date.now())
	const fixture = useMemo(() => buildErrorsLabFixture(nowMs), [nowMs])

	const [view, setView] = useState<HubView>("open")
	const [sort, setSort] = useState<HubSort>("last_seen")
	const [severity, setSeverity] = useState<SeverityFilter>("all")
	const [state, setState] = useState<LabState>("ready")
	const [width, setWidth] = useState<number | null>(null)

	const signals = useMemo(() => {
		if (state === "empty") return []
		return fixture.signals
			.filter((signal) => viewCovers(view, signal.issue.workflowState))
			.filter((signal) => {
				if (severity === "all") return true
				if (severity === "unset") return signal.severity === null
				return signal.severity === severity
			})
	}, [fixture.signals, state, view, severity])

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Errors" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Errors"
							description="Every error fingerprint, with what it is doing and who is on it."
						>
							<LabControls
								state={state}
								onStateChange={setState}
								width={width}
								onWidthChange={setWidth}
							/>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div
							className="@container/page mx-auto w-full min-w-0"
							style={width === null ? undefined : { maxWidth: width }}
						>
							<ErrorsHubView
								status={state === "ready" || state === "empty" ? "ready" : state}
								signals={signals}
								sparkWindow={fixture.sparkWindow}
								view={view}
								sort={sort}
								severity={severity}
								onViewChange={setView}
								onSortChange={setSort}
								onSeverityChange={setSeverity}
								stats={<LabStatStrip summary={fixture.summary} />}
								onRetry={() => setState("ready")}
							/>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function LabControls({
	state,
	onStateChange,
	width,
	onWidthChange,
}: {
	state: LabState
	onStateChange: (state: LabState) => void
	width: number | null
	onWidthChange: (width: number | null) => void
}) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<LabToggleGroup
				label="State"
				options={STATES.map((value) => ({ value, label: value }))}
				active={state}
				onChange={onStateChange}
			/>
			<LabToggleGroup
				label="Width"
				options={WIDTHS.map((entry) => ({ value: entry.value, label: entry.label }))}
				active={width}
				onChange={onWidthChange}
			/>
		</div>
	)
}

function LabToggleGroup<T extends string | number | null>({
	label,
	options,
	active,
	onChange,
}: {
	label: string
	options: ReadonlyArray<{ value: T; label: string }>
	active: T
	onChange: (value: T) => void
}) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
			<div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
				{options.map((option) => (
					<button
						key={String(option.value)}
						type="button"
						onClick={() => onChange(option.value)}
						className={cn(
							"h-6 rounded px-2 text-xs transition-colors",
							option.value === active
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</div>
		</div>
	)
}

/** The stat strip's success branch over fixture numbers. Deliberately a copy of
 *  the shape rather than the component: `ErrorsStatStrip` fetches for itself,
 *  and a lab that needed a warehouse would not be a lab. */
function LabStatStrip({
	summary,
}: {
	summary: {
		totalErrors: number
		errorRate: number
		affectedServicesCount: number
		affectedTracesCount: number
	}
}) {
	const stats = [
		{ value: formatNumber(summary.totalErrors), label: "errors" },
		{ value: formatErrorRate(summary.errorRate), label: "of all spans" },
		{ value: formatNumber(summary.affectedServicesCount), label: "services" },
		{ value: formatNumber(summary.affectedTracesCount), label: "traces" },
	]
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
			{stats.map((stat) => (
				<span key={stat.label} className="flex items-baseline gap-1.5">
					<span className="font-medium tabular-nums text-foreground">{stat.value}</span>
					<span className="text-muted-foreground">{stat.label}</span>
				</span>
			))}
			<span className="text-muted-foreground/60">in the selected window</span>
		</div>
	)
}

import { useEffect, useState } from "react"
import { Result } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { browserIconFor, deviceIconFor } from "@/components/replays/session-icons"
import { Route } from "@/routes/replays"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Label } from "@maple/ui/components/ui/label"
import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import {
	RangeFilterSection,
	formatSeconds,
	type RangeBucket,
	type RangePreset,
} from "@maple/ui/components/filters/range-filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

interface ReplaysFacetItem {
	readonly name: string
	readonly count: number
}

interface ReplaysFacets {
	readonly services: ReadonlyArray<ReplaysFacetItem>
	readonly browsers: ReadonlyArray<ReplaysFacetItem>
	readonly countries: ReadonlyArray<ReplaysFacetItem>
	readonly devices: ReadonlyArray<ReplaysFacetItem>
	/** Identified groups (company / team). Empty for orgs that never call
	 *  `identify()` with a group — the section hides itself then. */
	readonly groups: ReadonlyArray<ReplaysFacetItem>
	readonly errorCount: number
	/** Session-length distribution: `name` is the bucket floor in ms. */
	readonly durationBuckets: ReadonlyArray<ReplaysFacetItem>
	readonly durationP50: number
	readonly durationP95: number
}

/** Share of sessions the axis must cover before the rest is folded into a single
 *  overflow bar. Real data has abandoned tabs measured in days; on a log axis one
 *  of those stretches the range past 500h and squashes every genuine session into
 *  the first few pixels. */
const AXIS_COVERAGE = 0.99

// The warehouse buckets session length into half-octaves from 1s and returns only
// the non-empty ones (see sessionReplaysFacetsQuery). Rebuild the full run, in
// seconds, so the histogram's axis stays continuous instead of collapsing gaps
// into neighbouring bars.
export function toDurationBuckets(raw: ReadonlyArray<ReplaysFacetItem>): RangeBucket[] {
	const counts = new Map<number, number>()
	for (const item of raw) {
		const floorMs = Number(item.name)
		if (!Number.isFinite(floorMs) || floorMs <= 0) continue
		counts.set(Math.round(Math.log2(floorMs / 1000) * 2), item.count)
	}
	if (counts.size === 0) return []

	const octaves = [...counts.keys()]
	const buckets: RangeBucket[] = []
	for (let k = Math.min(...octaves); k <= Math.max(...octaves); k++) {
		const from = 2 ** (k / 2)
		buckets.push({ from, to: from * Math.SQRT2, count: counts.get(k) ?? 0 })
	}

	// Keep the outliers visible as one unbounded bar at the right edge rather than
	// dropping them — they're real sessions, and folding them into the last kept
	// bucket would misreport it as a spike.
	const total = buckets.reduce((sum, b) => sum + b.count, 0)
	if (total === 0) return buckets
	let covered = 0
	for (const [index, bucket] of buckets.entries()) {
		covered += bucket.count
		if (covered < total * AXIS_COVERAGE) continue
		const tail = buckets.slice(index + 1)
		const tailCount = tail.reduce((sum, b) => sum + b.count, 0)
		if (tailCount === 0) return buckets.slice(0, index + 1)
		return [
			...buckets.slice(0, index + 1),
			{ from: tail[0]!.from, to: Number.POSITIVE_INFINITY, count: tailCount, unbounded: true },
		]
	}
	return buckets
}

// "Bounced" is the one shortcut that names an intent rather than a threshold;
// the percentiles are this audience's own vocabulary and carry their resolved
// value. Percentiles under a second make a degenerate preset — skip them.
function sessionLengthPresets(p50Ms: number, p95Ms: number): RangePreset[] {
	const presets: RangePreset[] = [{ key: "bounced", label: "Bounced", value: "<10s", max: 10 }]
	for (const [key, label, ms] of [
		["p50", "> p50", p50Ms],
		["p95", "> p95", p95Ms],
	] as const) {
		const seconds = roundThreshold(ms / 1000)
		if (seconds >= 1) presets.push({ key, label, value: formatSeconds(seconds), min: seconds })
	}
	return presets
}

/** A percentile lands on values like 2647s, which reads as "44m 7s" — precision
 *  no one asked for on a shortcut. Round to the nearest minute above a minute;
 *  the seconds it drops can't change which sessions you care about. */
function roundThreshold(seconds: number): number {
	if (seconds < 60) return Math.round(seconds)
	return Math.round(seconds / 60) * 60
}

// Active time has no distribution behind it — computing one means scanning
// session_events for every session in the window, which the list path is built
// to avoid. Static thresholds, named for what they mean.
const ACTIVE_TIME_PRESETS: RangePreset[] = [
	{ key: "idle", label: "Idle", value: "<5s", max: 5 },
	{ key: "engaged", label: "Engaged", value: ">30s", min: 30 },
]

// The facet branches exclude their own dimension server-side, so a selected
// value can vanish from its own option list. Re-inject it (count 0) so it stays
// checkable/uncheckable rather than silently disappearing.
function withSelected(options: ReadonlyArray<ReplaysFacetItem>, selected?: string): FilterOption[] {
	const list = options.map((o) => ({ name: o.name, count: o.count }))
	if (selected && !list.some((o) => o.name === selected)) {
		list.unshift({ name: selected, count: 0 })
	}
	return list
}

interface ReplaysFilterSidebarProps {
	facetsResult: Result.Result<ReplaysFacets, unknown>
}

export function ReplaysFilterSidebar({ facetsResult }: ReplaysFilterSidebarProps) {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	// Single-value params: take the last toggled option (switching dimensions
	// replaces the prior value; unchecking the only one clears it).
	const setSingle = (key: "service" | "browser" | "country" | "deviceType" | "group", values: string[]) => {
		navigate({
			search: (prev) => ({ ...prev, [key]: values.at(-1) ?? undefined }),
		})
	}

	const toggleHasErrors = (checked: boolean) => {
		navigate({
			search: (prev) => ({ ...prev, hasErrors: checked || undefined }),
		})
	}

	const setUserId = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, userId: value }) })
	}

	const setUserSearch = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, user: value }) })
	}

	// Session-time ranges (seconds in the URL; mapped to ms before the query).
	const setDurationRange = (min: number | undefined, max: number | undefined) => {
		navigate({ search: (prev) => ({ ...prev, durationMin: min, durationMax: max }) })
	}

	const setActiveRange = (min: number | undefined, max: number | undefined) => {
		navigate({ search: (prev) => ({ ...prev, activeMin: min, activeMax: max }) })
	}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				q: search.q,
			},
		})
	}

	const hasActiveFilters =
		!!search.service ||
		!!search.browser ||
		!!search.country ||
		!!search.deviceType ||
		!!search.userId ||
		!!search.user ||
		!!search.group ||
		search.hasErrors === true ||
		search.durationMin != null ||
		search.durationMax != null ||
		search.activeMin != null ||
		search.activeMax != null

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={5} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facets, result) => {
			const services = withSelected(facets.services, search.service)
			const browsers = withSelected(facets.browsers, search.browser)
			const countries = withSelected(facets.countries, search.country)
			const devices = withSelected(facets.devices, search.deviceType)
			const groups = withSelected(facets.groups, search.group)

			const hasFacets =
				services.length > 0 ||
				browsers.length > 0 ||
				countries.length > 0 ||
				devices.length > 0 ||
				groups.length > 0 ||
				facets.errorCount > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<TextFilter
							id="replays-user-search"
							label="Name or email"
							placeholder="Filter by name or email…"
							clearLabel="Clear name or email filter"
							value={search.user}
							onApply={setUserSearch}
						/>

						<TextFilter
							id="replays-user-filter"
							label="User ID"
							placeholder="Filter by user ID…"
							clearLabel="Clear user ID filter"
							value={search.userId}
							onApply={setUserId}
						/>

						<SingleCheckboxFilter
							title="Has errors"
							checked={search.hasErrors === true}
							onChange={toggleHasErrors}
							count={facets.errorCount}
						/>

						<RangeFilterSection
							title="Session length"
							unit="s"
							minValue={search.durationMin}
							maxValue={search.durationMax}
							onRangeChange={setDurationRange}
							histogram={toDurationBuckets(facets.durationBuckets)}
							presets={sessionLengthPresets(facets.durationP50, facets.durationP95)}
						/>

						<RangeFilterSection
							title="Active time"
							hint="Excludes idle gaps"
							unit="s"
							minValue={search.activeMin}
							maxValue={search.activeMax}
							onRangeChange={setActiveRange}
							presets={ACTIVE_TIME_PRESETS}
						/>

						<SearchableFilterSection
							title="Service"
							options={services}
							selected={search.service ? [search.service] : []}
							onChange={(vals) => setSingle("service", vals)}
						/>

						<SearchableFilterSection
							title="Browser"
							options={browsers}
							selected={search.browser ? [search.browser] : []}
							onChange={(vals) => setSingle("browser", vals)}
							getOptionIcon={browserIconFor}
						/>

						{/* Hidden entirely when nobody is grouped — an empty facet list here
						    would just read as a broken section. */}
						{groups.length > 0 && (
							<SearchableFilterSection
								title="Group"
								options={groups}
								selected={search.group ? [search.group] : []}
								onChange={(vals) => setSingle("group", vals)}
							/>
						)}

						<FilterSection
							title="Device"
							options={devices}
							selected={search.deviceType ? [search.deviceType] : []}
							onChange={(vals) => setSingle("deviceType", vals)}
							getOptionIcon={deviceIconFor}
						/>

						<SearchableFilterSection
							title="Country"
							options={countries}
							selected={search.country ? [search.country] : []}
							onChange={(vals) => setSingle("country", vals)}
						/>

						{!hasFacets && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// Identity is high-cardinality, so it's typed rather than picked from a facet
// checklist. Both identity filters commit on Enter (not per-keystroke) — the
// user-id one is an exact match, where partial input matches nothing, and the
// name/email one would otherwise refetch on every letter. Mirrors the toolbar's
// local-state-synced input. The × clears both the field and the applied filter.
interface TextFilterProps {
	id: string
	label: string
	placeholder: string
	clearLabel: string
	value: string | undefined
	onApply: (value: string | undefined) => void
}

function TextFilter({ id, label, placeholder, clearLabel, value, onApply }: TextFilterProps) {
	const [text, setText] = useState(value ?? "")

	// Keep in sync when the param changes elsewhere (Clear all, the active-user chip's ×).
	useEffect(() => {
		setText(value ?? "")
	}, [value])

	const clear = () => {
		setText("")
		onApply(undefined)
	}

	return (
		<form
			className="py-2"
			onSubmit={(e) => {
				e.preventDefault()
				onApply(text.trim() || undefined)
			}}
		>
			<Label htmlFor={id} className={`mb-2 block ${FILTER_SECTION_LABEL} text-muted-foreground`}>
				{label}
			</Label>
			<InputGroup>
				<InputGroupAddon>
					<MagnifierIcon />
				</InputGroupAddon>
				<InputGroupInput
					id={id}
					size="sm"
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder={placeholder}
				/>
				{text && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton aria-label={clearLabel} onClick={clear}>
							<XmarkIcon />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</form>
	)
}

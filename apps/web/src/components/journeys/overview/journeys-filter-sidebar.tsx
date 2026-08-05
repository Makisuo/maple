import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"

import { Result } from "@/lib/effect-atom"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
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
import { Route } from "@/routes/journeys"
import { NumericRangeFilterSection } from "./numeric-range-filter-section"
import { formatTokens } from "./journeys-format"

interface JourneyFacetItem {
	readonly name: string
	readonly count: number
}

export interface JourneyFacets {
	readonly models: ReadonlyArray<JourneyFacetItem>
	readonly providers: ReadonlyArray<JourneyFacetItem>
	readonly agents: ReadonlyArray<JourneyFacetItem>
	readonly workflows: ReadonlyArray<JourneyFacetItem>
	readonly services: ReadonlyArray<JourneyFacetItem>
	readonly finishReasons: ReadonlyArray<JourneyFacetItem>
	readonly statuses: ReadonlyArray<JourneyFacetItem>
	readonly toolCount: number
	readonly redactedCount: number
	/** `name` is the bucket floor in ms; ceilings are floor × √2. */
	readonly durationBuckets: ReadonlyArray<JourneyFacetItem>
	readonly durationP50: number
	readonly durationP95: number
	readonly turnP50: number
	readonly turnP95: number
	readonly tokenP50: number
	readonly tokenP95: number
	/** Dollars. `0` when nothing in the window carried cost data. */
	readonly costP50: number
	readonly costP95: number
}

/** The status vocabulary, in the order the design lists it. */
const STATUS_ORDER = ["ok", "error", "running"] as const
const STATUS_LABELS: Record<string, string> = {
	ok: "succeeded",
	error: "errored",
	running: "in progress",
}

/** `length` is the one finish reason that means something went wrong: a response
 *  cut off by a token cap reads exactly like a finished one. Say so in the label. */
const FINISH_REASON_LABELS: Record<string, string> = {
	length: "length · truncated",
}

/**
 * Share of journeys the duration axis must cover before the rest folds into a
 * single overflow bar. Copied deliberately from the replays sidebar rather than
 * imported: the two pages bucket the same way (the warehouse emits half-octave
 * buckets from 1s for both), but importing would drag the replays route module
 * into this page's chunk for thirty lines of arithmetic.
 */
const AXIS_COVERAGE = 0.99

export function toDurationBuckets(raw: ReadonlyArray<JourneyFacetItem>): RangeBucket[] {
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

	const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
	if (total === 0) return buckets
	let covered = 0
	for (const [index, bucket] of buckets.entries()) {
		covered += bucket.count
		if (covered < total * AXIS_COVERAGE) continue
		const tail = buckets.slice(index + 1)
		const tailCount = tail.reduce((sum, entry) => sum + entry.count, 0)
		if (tailCount === 0) return buckets.slice(0, index + 1)
		return [
			...buckets.slice(0, index + 1),
			{
				from: tail[0]!.from,
				to: Number.POSITIVE_INFINITY,
				count: tailCount,
				unbounded: true,
			},
		]
	}
	return buckets
}

function durationPresets(p50Ms: number, p95Ms: number): RangePreset[] {
	const presets: RangePreset[] = []
	for (const [key, label, ms] of [
		["p50", "> p50", p50Ms],
		["p95", "> p95", p95Ms],
	] as const) {
		const seconds = ms / 1000
		if (seconds >= 1) {
			const rounded = seconds < 60 ? Math.round(seconds) : Math.round(seconds / 60) * 60
			presets.push({ key, label, value: formatSeconds(rounded), min: rounded })
		}
	}
	return presets
}

/** Facet branches exclude their own dimension server-side, so a selected value
 *  can vanish from its own option list. Re-inject it (count 0) so it stays
 *  uncheckable-from-where-you-checked-it rather than silently disappearing. */
function withSelected(options: ReadonlyArray<JourneyFacetItem>, selected?: string): FilterOption[] {
	const list = options.map((option) => ({
		name: option.name,
		count: option.count,
	}))
	if (selected && !list.some((option) => option.name === selected)) {
		list.unshift({ name: selected, count: 0 })
	}
	return list
}

const formatDollars = (value: number) => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`)

interface JourneysFilterSidebarProps {
	facetsResult: Result.Result<JourneyFacets, unknown>
}

export function JourneysFilterSidebar({ facetsResult }: JourneysFilterSidebarProps) {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	// Single-value params: take the last toggled option (switching values replaces
	// the prior one; unchecking the only one clears it).
	const setSingle = (
		key: "status" | "finishReason" | "agent" | "workflow" | "model" | "provider" | "service",
		values: string[],
	) => {
		navigate({
			search: (prev) => ({ ...prev, [key]: values.at(-1) ?? undefined }),
		})
	}

	const setRange =
		(
			minKey: "durationMin" | "turnMin" | "tokenMin" | "costMin",
			maxKey: "durationMax" | "turnMax" | "tokenMax" | "costMax",
		) =>
		(min: number | undefined, max: number | undefined) => {
			navigate({
				search: (prev) => ({ ...prev, [minKey]: min, [maxKey]: max }),
			})
		}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				sort: search.sort,
				sortDirection: search.sortDirection,
			},
		})
	}

	const hasActiveFilters =
		!!search.status ||
		!!search.finishReason ||
		!!search.agent ||
		!!search.workflow ||
		!!search.model ||
		!!search.provider ||
		!!search.service ||
		search.hasTools != null ||
		!!search.q ||
		search.durationMin != null ||
		search.durationMax != null ||
		search.turnMin != null ||
		search.turnMax != null ||
		search.tokenMin != null ||
		search.tokenMax != null ||
		search.costMin != null ||
		search.costMax != null

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={6} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facets, result) => {
			// Statuses come back in count order; the three buckets read better in
			// their own fixed order (succeeded, errored, in progress).
			const statuses = withSelected(
				[...facets.statuses].sort(
					(a, b) =>
						STATUS_ORDER.indexOf(a.name as (typeof STATUS_ORDER)[number]) -
						STATUS_ORDER.indexOf(b.name as (typeof STATUS_ORDER)[number]),
				),
				search.status,
			)
			const finishReasons = withSelected(facets.finishReasons, search.finishReason)
			const agents = withSelected(facets.agents, search.agent)
			const workflows = withSelected(facets.workflows, search.workflow)
			const models = withSelected(facets.models, search.model)
			const providers = withSelected(facets.providers, search.provider)
			const services = withSelected(facets.services, search.service)

			const hasFacets =
				statuses.length > 0 || finishReasons.length > 0 || agents.length > 0 || models.length > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<FilterSection
							title="Status"
							options={statuses}
							selected={search.status ? [search.status] : []}
							onChange={(values) => setSingle("status", values)}
							getOptionLabel={(name) => STATUS_LABELS[name] ?? name}
						/>

						<FilterSection
							title="Finish reason"
							options={finishReasons}
							selected={search.finishReason ? [search.finishReason] : []}
							onChange={(values) => setSingle("finishReason", values)}
							getOptionLabel={(name) => FINISH_REASON_LABELS[name] ?? name}
						/>

						<SearchableFilterSection
							title="Agent"
							options={agents}
							selected={search.agent ? [search.agent] : []}
							onChange={(values) => setSingle("agent", values)}
							maxVisible={4}
						/>

						{workflows.length > 0 && (
							<SearchableFilterSection
								title="Workflow"
								options={workflows}
								selected={search.workflow ? [search.workflow] : []}
								onChange={(values) => setSingle("workflow", values)}
								maxVisible={4}
							/>
						)}

						{/* A journey counts under every model it used, not only the
						    leading one — so the counts here can exceed the row count. */}
						<SearchableFilterSection
							title="Model"
							options={models}
							selected={search.model ? [search.model] : []}
							onChange={(values) => setSingle("model", values)}
						/>

						<FilterSection
							title="Provider"
							options={providers}
							selected={search.provider ? [search.provider] : []}
							onChange={(values) => setSingle("provider", values)}
						/>

						{services.length > 1 && (
							<SearchableFilterSection
								title="Service"
								options={services}
								selected={search.service ? [search.service] : []}
								onChange={(values) => setSingle("service", values)}
							/>
						)}

						{/* Mirrors the toolbar's "Used tools" chip; both stay in sync
						    because both write the one `hasTools` param. */}
						<SingleCheckboxFilter
							title="Used tools"
							checked={search.hasTools === true}
							onChange={(checked) =>
								navigate({
									search: (prev) => ({
										...prev,
										hasTools: checked || undefined,
									}),
								})
							}
							count={facets.toolCount}
						/>

						<NumericRangeFilterSection
							title="Cost"
							minValue={search.costMin}
							maxValue={search.costMax}
							onRangeChange={setRange("costMin", "costMax")}
							format={formatDollars}
							p50={facets.costP50}
							p95={facets.costP95}
							placeholderMin="$0"
							defaultOpen
						/>

						<RangeFilterSection
							title="Duration"
							unit="s"
							minValue={search.durationMin}
							maxValue={search.durationMax}
							onRangeChange={setRange("durationMin", "durationMax")}
							histogram={toDurationBuckets(facets.durationBuckets)}
							presets={durationPresets(facets.durationP50, facets.durationP95)}
							histogramUnitLabel="journeys"
							defaultOpen
						/>

						<NumericRangeFilterSection
							title="Turns"
							minValue={search.turnMin}
							maxValue={search.turnMax}
							onRangeChange={setRange("turnMin", "turnMax")}
							format={(value) => value.toLocaleString()}
							p50={facets.turnP50}
							p95={facets.turnP95}
						/>

						<NumericRangeFilterSection
							title="Tokens"
							minValue={search.tokenMin}
							maxValue={search.tokenMax}
							onRangeChange={setRange("tokenMin", "tokenMax")}
							format={formatTokens}
							p50={facets.tokenP50}
							p95={facets.tokenP95}
						/>

						{/* High cardinality, so it's typed rather than picked. The
						    warehouse's substring filter covers title and id alike, which
						    is the same param the toolbar search writes — one setting,
						    two surfaces. */}
						<JourneyIdFilter
							value={search.q}
							onApply={(value) => navigate({ search: (prev) => ({ ...prev, q: value }) })}
						/>

						{!hasFacets && (
							<p className="py-4 text-sm text-muted-foreground">
								No journeys in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

interface JourneyIdFilterProps {
	value: string | undefined
	onApply: (value: string | undefined) => void
}

/** Commits on Enter, not per keystroke — a partial id matches nothing useful and
 *  every commit re-runs both warehouse queries. */
function JourneyIdFilter({ value, onApply }: JourneyIdFilterProps) {
	const [text, setText] = useState(value ?? "")

	// Resync during render when the param changes elsewhere — the toolbar search
	// writes the same `q`, and "Clear all" wipes it.
	const [lastValue, setLastValue] = useState(value)
	if (value !== lastValue) {
		setLastValue(value)
		setText(value ?? "")
	}

	return (
		<form
			className="py-2"
			onSubmit={(event) => {
				event.preventDefault()
				onApply(text.trim() || undefined)
			}}
		>
			<Label
				htmlFor="journeys-id-filter"
				className={`mb-2 block ${FILTER_SECTION_LABEL} text-muted-foreground`}
			>
				Journey ID
			</Label>
			<InputGroup>
				<InputGroupAddon>
					<MagnifierIcon />
				</InputGroupAddon>
				<InputGroupInput
					id="journeys-id-filter"
					size="sm"
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="conversation or trace id"
				/>
				{text && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							aria-label="Clear journey id filter"
							onClick={() => {
								setText("")
								onApply(undefined)
							}}
						>
							<XmarkIcon />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</form>
	)
}

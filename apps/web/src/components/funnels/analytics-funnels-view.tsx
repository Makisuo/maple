import { useMemo, useState, type ReactNode } from "react"
import { Result } from "@/lib/effect-atom"

import { useDebouncedValue } from "@maple/ui/hooks/use-debounced-value"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { QueryErrorState } from "@/components/common/query-error-state"
import { ArrowTrendDownIcon, CodeIcon } from "@/components/icons"
import type { AnalyticsFilters } from "@/components/analytics/filters"
import {
	productEventNamesResultAtom,
	productEventsFunnelBreakdownResultAtom,
	productEventsFunnelResultAtom,
	webAnalyticsPagesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"

import {
	FUNNEL_KEY_BY_OPTIONS,
	FUNNEL_SESSION_DIMENSIONS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	FUNNEL_WINDOW_OPTIONS,
	completedSteps,
	stepLabel,
	type FunnelBreakdownBy,
	type FunnelDefinition,
	type FunnelKeyBy,
	type FunnelSessionDimension,
	type FunnelStep,
} from "./definition"
import { FunnelStepBuilder } from "./funnel-step-builder"
import { FunnelBreakdownTable, FunnelResults } from "./funnel-results"

// The Funnels view of /analytics. The definition lives in the URL (the route
// owns it and hands it down with a setter), so a funnel is a shareable link and
// the back button walks through edits. The sidebar filters come along as the
// population filter — the same object the Overview panels are narrowed by.

const PAGE_SUGGESTION_LIMIT = 100
const BREAKDOWN_LIMIT = 10

const ATTRIBUTE_PREFIX = "attribute:"
const NONE = "__none__"
const ATTRIBUTE = "__attribute__"

/** How long the definition may keep changing before it reaches the warehouse. */
const DEFINITION_DEBOUNCE_MS = 400

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	session: "sessions",
} satisfies Record<FunnelKeyBy, string>

interface AnalyticsFunnelsViewProps {
	startTime: string
	endTime: string
	filters: AnalyticsFilters
	definition: FunnelDefinition
	onDefinitionChange: (definition: FunnelDefinition) => void
}

export function AnalyticsFunnelsView({
	startTime,
	endTime,
	filters,
	definition,
	onDefinitionChange,
}: AnalyticsFunnelsViewProps) {
	const windowInput = { startTime, endTime, ...filters }

	const eventNamesResult = useRetainedRefreshableResultValue(
		productEventNamesResultAtom({ data: { ...windowInput, limit: 200 } }),
	)
	const pagesResult = useRetainedRefreshableResultValue(
		webAnalyticsPagesResultAtom({ data: { ...windowInput, limit: PAGE_SUGGESTION_LIMIT } }),
	)

	const eventNames = Result.builder(eventNamesResult)
		.onSuccess((rows) => rows.data)
		.orElse(() => [])
	// The picker lists `track()` events; page views are the Page step's business.
	const customEvents = eventNames.filter((row) => row.kind !== "navigation")
	const eventSuggestions = customEvents.map((row) => ({ name: row.eventName, count: row.count }))
	const pageSuggestions = Result.builder(pagesResult)
		.onSuccess((rows) => rows.data.map((page) => ({ name: page.pagePath, count: page.pageViews })))
		.orElse(() => [])

	// Only complete steps go to the warehouse — a step still being typed would
	// otherwise 400 on the blank name — and they go there DEBOUNCED: every
	// keystroke in an event name or page path is a new atom key, i.e. its own
	// `windowFunnel` aggregation (plus a breakdown), and `staleTime` cannot
	// coalesce keys that never repeat. Debouncing a serialized key rather than the
	// array keeps the comparison by value, so an unrelated re-render does not
	// re-arm the timer.
	const stepsKey = JSON.stringify(completedSteps(definition.steps))
	const debouncedStepsKey = useDebouncedValue(stepsKey, DEFINITION_DEBOUNCE_MS)
	// SAFETY: `debouncedStepsKey` is only ever a value `stepsKey` held, i.e. a
	// `JSON.stringify` of the `completedSteps()` array above, so it parses back to
	// exactly that shape.
	const steps = useMemo(
		() => JSON.parse(debouncedStepsKey) as ReadonlyArray<FunnelStep>,
		[debouncedStepsKey],
	)
	const breakdownBy = useDebouncedValue(definition.breakdownBy, DEFINITION_DEBOUNCE_MS)
	const labels = steps.map(stepLabel)
	const unitNoun = KEY_BY_NOUN[definition.keyBy]

	const set = (patch: Partial<FunnelDefinition>) => onDefinitionChange({ ...definition, ...patch })

	return (
		<div className="space-y-4">
			<div className="rounded-md border bg-card">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-2">
					<div className="flex items-baseline gap-2">
						<span className="text-xs font-medium">Steps</span>
						<span className="font-mono text-[10px] text-muted-foreground">
							in order · session step only first · up to 10
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<LabelledSelect label="Count">
							<Select
								items={Object.fromEntries(
									FUNNEL_KEY_BY_OPTIONS.map((option) => [option.value, option.label]),
								)}
								value={definition.keyBy}
								onValueChange={(value) => {
									const option = FUNNEL_KEY_BY_OPTIONS.find(
										(candidate) => candidate.value === value,
									)
									if (option) set({ keyBy: option.value })
								}}
							>
								<SelectTrigger size="sm" className="w-28 min-w-0" aria-label="Count by">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FUNNEL_KEY_BY_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											<span className="flex flex-col">
												<span>{option.label}</span>
												<span className="text-[10px] text-muted-foreground">
													{option.description}
												</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</LabelledSelect>
						<LabelledSelect label="Within">
							<Select
								items={Object.fromEntries(
									FUNNEL_WINDOW_OPTIONS.map((option) => [
										String(option.value),
										option.label,
									]),
								)}
								value={String(definition.windowSeconds)}
								onValueChange={(value) => {
									const seconds = Number(value)
									if (Number.isFinite(seconds) && seconds > 0)
										set({ windowSeconds: seconds })
								}}
							>
								<SelectTrigger
									size="sm"
									className="w-28 min-w-0"
									aria-label="Conversion window"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FUNNEL_WINDOW_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={String(option.value)}>
											{option.label}
										</SelectItem>
									))}
									{FUNNEL_WINDOW_OPTIONS.every(
										(option) => option.value !== definition.windowSeconds,
									) ? (
										<SelectItem value={String(definition.windowSeconds)}>
											{definition.windowSeconds}s
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
						</LabelledSelect>
						<BreakdownPicker
							value={definition.breakdownBy}
							onChange={(breakdownBy) =>
								onDefinitionChange(
									breakdownBy === undefined
										? {
												steps: definition.steps,
												keyBy: definition.keyBy,
												windowSeconds: definition.windowSeconds,
											}
										: { ...definition, breakdownBy },
								)
							}
						/>
					</div>
				</div>
				<div className="px-4 pb-4">
					<FunnelStepBuilder
						steps={definition.steps}
						onChange={(next) => set({ steps: next })}
						eventNames={eventSuggestions}
						pagePaths={pageSuggestions}
					/>
				</div>
			</div>

			{Result.isSuccess(eventNamesResult) && customEvents.length === 0 ? (
				<NoCustomEventsCallout />
			) : null}

			{steps.length === 0 ? (
				<Empty className="rounded-md border border-dashed bg-card/40 py-12">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ArrowTrendDownIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>Add a step to see conversion</EmptyTitle>
						<EmptyDescription>
							Pick an event, a page, or — for step 1 — how the session was acquired. Each
							further step is counted only for {unitNoun} who did the previous one first, inside
							the window.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<FunnelQueries
					input={{
						...windowInput,
						steps,
						keyBy: definition.keyBy,
						windowSeconds: definition.windowSeconds,
					}}
					labels={labels}
					unitNoun={unitNoun}
					breakdownBy={breakdownBy}
				/>
			)}
		</div>
	)
}

function FunnelQueries({
	input,
	labels,
	unitNoun,
	breakdownBy,
}: {
	input: Parameters<typeof productEventsFunnelResultAtom>[0]["data"]
	labels: ReadonlyArray<string>
	unitNoun: string
	breakdownBy: FunnelBreakdownBy | undefined
}) {
	const funnelResult = useRetainedRefreshableResultValue(productEventsFunnelResultAtom({ data: input }))
	return (
		<>
			{Result.builder(funnelResult)
				.onInitial(() => (
					<>
						<Skeleton className="h-56 w-full" />
						<Skeleton className="h-40 w-full" />
					</>
				))
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((rows, result) => (
					<FunnelResults
						labels={labels}
						rows={rows.data}
						unitNoun={unitNoun}
						waiting={result.waiting}
					/>
				))
				.render()}
			{breakdownBy !== undefined ? (
				<FunnelBreakdownQuery input={input} labels={labels} breakdownBy={breakdownBy} />
			) : null}
		</>
	)
}

function FunnelBreakdownQuery({
	input,
	labels,
	breakdownBy,
}: {
	input: Parameters<typeof productEventsFunnelResultAtom>[0]["data"]
	labels: ReadonlyArray<string>
	breakdownBy: FunnelBreakdownBy
}) {
	const breakdownResult = useRetainedRefreshableResultValue(
		productEventsFunnelBreakdownResultAtom({ data: { ...input, breakdownBy, limit: BREAKDOWN_LIMIT } }),
	)
	return Result.builder(breakdownResult)
		.onInitial(() => <Skeleton className="h-40 w-full" />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((rows, result) => (
			<FunnelBreakdownTable
				labels={labels}
				breakdownBy={breakdownBy}
				rows={rows.data}
				waiting={result.waiting}
			/>
		))
		.render()
}

function LabelledSelect({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[11px] text-muted-foreground">{label}</span>
			{children}
		</div>
	)
}

/**
 * Breakdown: none, one of the session dimensions, or `attribute:<key>` typed
 * by hand — the attribute keys on `track()` events are the customer's own
 * vocabulary and there is no cheap way to list them.
 *
 * "Attribute…" and the key it needs are two interactions, so the mode is held
 * here and only a NON-EMPTY key becomes a `breakdownBy`. Emitting the bare
 * `attribute:` prefix would break the funnel down by `Attributes['']`, which no
 * event carries: every person lands in the `(none)` group, and the aggregation
 * that produced it was pure waste.
 */
function BreakdownPicker({
	value,
	onChange,
}: {
	value: FunnelBreakdownBy | undefined
	onChange: (value: FunnelBreakdownBy | undefined) => void
}) {
	const fromValue = value !== undefined && value.startsWith(ATTRIBUTE_PREFIX)
	const [attributeMode, setAttributeMode] = useState(fromValue)
	const [attributeKey, setAttributeKey] = useState(fromValue ? value.slice(ATTRIBUTE_PREFIX.length) : "")
	// The local mode only survives while nothing else is selected, so a URL that
	// changes under us (Back, a shared link) wins over a stale "Attribute…".
	const isAttribute = fromValue || (attributeMode && value === undefined)
	const selected = isAttribute ? ATTRIBUTE : value === undefined ? NONE : value
	const items = {
		[NONE]: "None",
		...FUNNEL_SESSION_DIMENSION_LABEL,
		[ATTRIBUTE]: "Attribute…",
	}
	const emitAttribute = (key: string) => {
		const trimmed = key.trim()
		onChange(trimmed.length > 0 ? `${ATTRIBUTE_PREFIX}${trimmed}` : undefined)
	}
	return (
		<LabelledSelect label="Break down by">
			<Select
				items={items}
				value={selected}
				onValueChange={(next) => {
					if (next === NONE) {
						setAttributeMode(false)
						onChange(undefined)
					} else if (next === ATTRIBUTE) {
						setAttributeMode(true)
						emitAttribute(attributeKey)
					} else if (FUNNEL_SESSION_DIMENSIONS.includes(next as FunnelSessionDimension)) {
						setAttributeMode(false)
						onChange(next as FunnelSessionDimension)
					}
				}}
			>
				<SelectTrigger size="sm" className="w-32 min-w-0" aria-label="Break down by">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NONE}>None</SelectItem>
					{FUNNEL_SESSION_DIMENSIONS.map((dimension) => (
						<SelectItem key={dimension} value={dimension}>
							{FUNNEL_SESSION_DIMENSION_LABEL[dimension]}
						</SelectItem>
					))}
					<SelectItem value={ATTRIBUTE}>Attribute…</SelectItem>
				</SelectContent>
			</Select>
			{isAttribute ? (
				<Input
					size="sm"
					value={attributeKey}
					onChange={(event) => {
						setAttributeKey(event.target.value)
						emitAttribute(event.target.value)
					}}
					placeholder="attribute key, e.g. plan"
					aria-label="Breakdown attribute key"
					className="w-40 font-mono text-xs"
				/>
			) : null}
		</LabelledSelect>
	)
}

/**
 * Shown when nothing but page views has arrived: the funnel still works over
 * pages, but the reason to open this tab is `track()`, so say how to start.
 */
function NoCustomEventsCallout() {
	return (
		<div className="flex flex-wrap items-start gap-3 rounded-md border border-dashed bg-card/40 px-4 py-3">
			<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
				<CodeIcon size={14} />
			</span>
			<div className="min-w-0 flex-1 space-y-1">
				<p className="text-xs font-medium">No custom events in this window</p>
				<p className="text-[12px] text-muted-foreground">
					Page steps work from the page views you already send. To measure signups, checkouts and
					the steps in between, call{" "}
					<code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
						maple.track("signup_completed", {'{ plan: "pro" }'})
					</code>{" "}
					from the browser SDK, or{" "}
					<code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
						MapleEvents.track()
					</code>{" "}
					server-side — each name shows up here as a step.
				</p>
			</div>
		</div>
	)
}

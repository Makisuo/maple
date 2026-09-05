import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import type { QueryBuilderDataSource } from "@maple/query-engine/query-builder"

import { BreakdownPicker } from "@/components/funnels/breakdown-picker"
import {
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
	FUNNEL_KEY_BY_OPTIONS,
	FUNNEL_WINDOW_OPTIONS,
} from "@/components/funnels/definition"
import { FunnelStepBuilder } from "@/components/funnels/funnel-step-builder"
import { useFunnelSuggestions, type FunnelSuggestions } from "@/components/funnels/use-funnel-suggestions"
import {
	AddOnToggleBar,
	QUERY_BUILDER_PANEL_SOURCES,
	QueryPanelShell,
	isQueryBuilderDataSource,
} from "@/components/dashboard-builder/config/query-panel-shell"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { parseProductEventsFilterClause } from "@/lib/query-builder/funnel-filters"
import type { FunnelAddOnKey, FunnelWidgetDraft } from "@/lib/query-builder/widget-builder-shared"

// The funnel widget's query panel when its source is Product events. Same
// chrome as a traces/logs/metrics `QueryPanel` — badge, source select, body,
// add-on bar — with the funnel definition as the body: the ordered steps (each
// with its own attribute filter), a population where-clause, and Count by /
// Window / Breakdown as add-ons. Every edit goes to the builder state; Run
// Preview and Apply lower it through `funnelWidgetType`, exactly as a query
// set is lowered.

const ADD_ONS: ReadonlyArray<{ key: FunnelAddOnKey; label: string }> = [
	{ key: "keyBy", label: "Count by" },
	{ key: "window", label: "Window" },
	{ key: "breakdown", label: "Breakdown" },
]

interface FunnelQueryPanelViewProps {
	funnel: FunnelWidgetDraft
	onUpdate: (updater: (funnel: FunnelWidgetDraft) => FunnelWidgetDraft) => void
	/** The user picked Traces / Logs / Metrics: the widget goes back to its query set. */
	onSourceChange: (source: QueryBuilderDataSource) => void
	/** What the inputs complete from; `useFunnelSuggestions` is the one real source. */
	suggestions: FunnelSuggestions
}

interface FunnelQueryPanelProps extends Omit<FunnelQueryPanelViewProps, "suggestions"> {
	/** The window suggestions are drawn from — the dashboard's, or the widget's override. */
	suggestionWindow: { startTime: string; endTime: string } | undefined
}

/** The panel with its suggestions fetched over `suggestionWindow`. */
export function FunnelQueryPanel({ suggestionWindow, ...props }: FunnelQueryPanelProps) {
	const suggestions = useFunnelSuggestions(suggestionWindow)
	return <FunnelQueryPanelView {...props} suggestions={suggestions} />
}

/** The panel itself, suggestions handed in — what a test renders without a warehouse. */
export function FunnelQueryPanelView({
	funnel,
	onUpdate,
	onSourceChange,
	suggestions,
}: FunnelQueryPanelViewProps) {
	const filterParse = parseProductEventsFilterClause(funnel.filterClause)
	const filterError = filterParse.ok ? null : filterParse.error

	const toggleAddOn = (key: FunnelAddOnKey) =>
		onUpdate((current) => {
			const next = !current.addOns[key]
			const addOns = { ...current.addOns, [key]: next }
			// Turning an add-on off puts its value back to the default, so the
			// bar reads as "what is set" — the same contract as a query's add-ons.
			if (next) return { ...current, addOns }
			switch (key) {
				case "keyBy":
					return { ...current, addOns, keyBy: DEFAULT_FUNNEL_KEY_BY }
				case "window":
					return { ...current, addOns, windowSeconds: DEFAULT_FUNNEL_WINDOW_SECONDS }
				case "breakdown": {
					const { breakdownBy: _breakdownBy, ...rest } = current
					return { ...rest, addOns }
				}
			}
		})

	const hasAnyAddOn = Object.values(funnel.addOns).some(Boolean)

	return (
		<QueryPanelShell
			name="A"
			index={0}
			source="product_events"
			sourceOptions={[...QUERY_BUILDER_PANEL_SOURCES, "product_events"]}
			onSourceChange={(source) => {
				if (isQueryBuilderDataSource(source)) onSourceChange(source)
			}}
			headerActions={
				<Button variant="ghost" size="xs" disabled>
					Remove
				</Button>
			}
		>
			{/* Steps */}
			<div className="space-y-1.5">
				<div className="flex items-baseline gap-2">
					<span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
						Steps
					</span>
					<span className="font-mono text-[10px] text-muted-foreground">
						in order · session step only first · up to 10
					</span>
				</div>
				<FunnelStepBuilder
					steps={funnel.steps}
					onChange={(steps) => onUpdate((current) => ({ ...current, steps: [...steps] }))}
					eventNames={suggestions.eventNames}
					pagePaths={suggestions.pagePaths}
					eventStepFilter
					pageStepHost
					compact
				/>
			</div>

			{/* Population filter */}
			<div className="space-y-1">
				<div className="flex items-start gap-2">
					<span className="w-16 shrink-0 pt-2 text-[11px] text-muted-foreground">Where</span>
					{/* The vocabulary is the `product_events` scope's; the data source is
					    the editor's required prop and is not consulted under that scope,
					    and the facet values come in explicitly. */}
					<WhereClauseEditor
						className="flex-1"
						rows={1}
						value={funnel.filterClause}
						dataSource="traces"
						autocompleteScope="product_events"
						values={{ productEventFacets: suggestions.facets }}
						onChange={(filterClause) => onUpdate((current) => ({ ...current, filterClause }))}
						placeholder='country = "DE" AND utm.source = "twitter"'
						textareaClassName="min-h-[32px] resize-y text-xs"
						ariaLabel="Funnel population filter"
					/>
				</div>
				<p className="pl-18 text-[11px] text-muted-foreground">
					{filterError ? (
						<span className="text-destructive">{filterError}</span>
					) : (
						"Only persons with a session matching these dimensions take part."
					)}
				</p>
			</div>

			{/* Add-on toggle bar */}
			<AddOnToggleBar items={ADD_ONS} active={funnel.addOns} onToggle={toggleAddOn} />

			{hasAnyAddOn && (
				<div className="space-y-2 pt-1">
					{funnel.addOns.keyBy && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Count by</span>
							<Select
								items={Object.fromEntries(
									FUNNEL_KEY_BY_OPTIONS.map((option) => [option.value, option.label]),
								)}
								value={funnel.keyBy}
								onValueChange={(value) => {
									const option = FUNNEL_KEY_BY_OPTIONS.find(
										(candidate) => candidate.value === value,
									)
									if (option) onUpdate((current) => ({ ...current, keyBy: option.value }))
								}}
							>
								<SelectTrigger className="h-8 w-[220px] text-xs" aria-label="Count by">
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
						</div>
					)}

					{funnel.addOns.window && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Window</span>
							<Select
								items={Object.fromEntries(
									FUNNEL_WINDOW_OPTIONS.map((option) => [
										String(option.value),
										option.label,
									]),
								)}
								value={String(funnel.windowSeconds)}
								onValueChange={(value) => {
									const seconds = Number(value)
									if (Number.isFinite(seconds) && seconds > 0) {
										onUpdate((current) => ({ ...current, windowSeconds: seconds }))
									}
								}}
							>
								<SelectTrigger
									className="h-8 w-[160px] text-xs"
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
										(option) => option.value !== funnel.windowSeconds,
									) ? (
										<SelectItem value={String(funnel.windowSeconds)}>
											{funnel.windowSeconds}s
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
							<span className="text-[11px] text-muted-foreground">
								the whole chain must complete within this long of step 1
							</span>
						</div>
					)}

					{funnel.addOns.breakdown && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Breakdown</span>
							<BreakdownPicker
								value={funnel.breakdownBy}
								onChange={(breakdownBy) =>
									onUpdate((current) => {
										const { breakdownBy: _previous, ...rest } = current
										return breakdownBy === undefined ? rest : { ...rest, breakdownBy }
									})
								}
							/>
							<span className="text-[11px] text-muted-foreground">
								one bar per group, top 6
							</span>
						</div>
					)}
				</div>
			)}
		</QueryPanelShell>
	)
}

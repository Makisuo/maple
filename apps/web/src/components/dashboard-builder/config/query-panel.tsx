import * as React from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { cn } from "@maple/ui/utils"
import { GroupByMultiSelect } from "@/components/query-builder/group-by-multi-select"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"
import {
	AGGREGATIONS_BY_SOURCE,
	QUERY_BUILDER_METRIC_TYPES,
	getMetricsAggregations,
	queryBadgeColor,
	type QueryBuilderAddOnKey,
	type QueryBuilderDataSource,
	type QueryBuilderMetricType,
	type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricSelectionOption {
	value: string
	label: string
	isMonotonic: boolean
}

interface AutocompleteValues {
	traces: WhereClauseAutocompleteValues
	logs: WhereClauseAutocompleteValues
	metrics: WhereClauseAutocompleteValues
}

interface QueryPanelProps {
	query: QueryBuilderQueryDraft
	index: number
	canRemove: boolean
	metricSelectionOptions: MetricSelectionOption[]
	onMetricSearch?: (search: string) => void
	autocompleteValues: AutocompleteValues
	onUpdate: (updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => void
	onAggregationChange: (aggregation: string) => void
	onMetricSelectionChange: (selection: {
		metricName: string
		metricType: QueryBuilderMetricType
		isMonotonic: boolean
	}) => void
	onClone: () => void
	onRemove: () => void
	onDataSourceChange: (ds: QueryBuilderDataSource) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetricSelection(raw: string): {
	metricName: string
	metricType: QueryBuilderMetricType
} | null {
	const [metricName, metricType] = raw.split("::")
	if (!metricName || !metricType) return null
	if (!QUERY_BUILDER_METRIC_TYPES.includes(metricType as QueryBuilderMetricType)) return null
	return { metricName, metricType: metricType as QueryBuilderMetricType }
}

const ADD_ON_KEYS: { key: QueryBuilderAddOnKey; label: string }[] = [
	{ key: "groupBy", label: "Group By" },
	{ key: "having", label: "Having" },
	{ key: "orderBy", label: "Order By" },
	{ key: "limit", label: "Limit" },
	{ key: "legend", label: "Legend" },
]

// ---------------------------------------------------------------------------
// QueryPanel
// ---------------------------------------------------------------------------

export function QueryPanel({
	query,
	index,
	canRemove,
	metricSelectionOptions,
	onMetricSearch,
	autocompleteValues,
	onUpdate,
	onAggregationChange,
	onMetricSelectionChange,
	onClone,
	onRemove,
	onDataSourceChange,
}: QueryPanelProps) {
	const [collapsed, setCollapsed] = React.useState(false)
	const badgeColor = queryBadgeColor(index)
	const aggregateOptions =
		query.dataSource === "metrics"
			? getMetricsAggregations(query.metricType || "gauge", query.isMonotonic)
			: AGGREGATIONS_BY_SOURCE[query.dataSource]

	const metricValue =
		query.metricName && query.metricType ? `${query.metricName}::${query.metricType}` : undefined

	const isMetrics = query.dataSource === "metrics"

	return (
		<div className="border rounded-md">
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
					aria-label={collapsed ? "Expand query" : "Collapse query"}
				>
					{collapsed ? "\u25B6" : "\u25BC"}
				</button>

				<Checkbox
					id={`query-visible-${query.id}`}
					checked={!query.hidden}
					onCheckedChange={(checked) =>
						onUpdate((current) => ({
							...current,
							hidden: checked !== true,
						}))
					}
					className="shrink-0"
				/>

				<Badge
					variant="outline"
					className={cn("font-mono text-[11px] text-white border-0 shrink-0", badgeColor)}
				>
					{query.name}
				</Badge>

				<Select
					items={{ traces: "Traces", logs: "Logs", metrics: "Metrics" }}
					value={query.dataSource}
					onValueChange={(value) => onDataSourceChange(value as QueryBuilderDataSource)}
				>
					<SelectTrigger className="h-7 w-24 text-xs border-none bg-transparent shadow-none px-1">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="traces">Traces</SelectItem>
						<SelectItem value="logs">Logs</SelectItem>
						<SelectItem value="metrics">Metrics</SelectItem>
					</SelectContent>
				</Select>

				<div className="flex-1" />

				<Button variant="ghost" size="xs" onClick={onClone}>
					Clone
				</Button>
				<Button variant="ghost" size="xs" onClick={onRemove} disabled={!canRemove}>
					Remove
				</Button>
			</div>

			{/* Body */}
			{!collapsed && (
				<div className="px-3 py-3 space-y-3">
					{isMetrics ? (
						<MetricsBody
							query={query}
							aggregateOptions={aggregateOptions}
							metricValue={metricValue}
							metricSelectionOptions={metricSelectionOptions}
							onMetricSearch={onMetricSearch}
							autocompleteValues={autocompleteValues}
							onUpdate={onUpdate}
							onMetricSelectionChange={onMetricSelectionChange}
							onAggregationChange={onAggregationChange}
						/>
					) : (
						<TracesLogsBody
							query={query}
							aggregateOptions={aggregateOptions}
							autocompleteValues={autocompleteValues}
							onUpdate={onUpdate}
							onAggregationChange={onAggregationChange}
						/>
					)}

					{/* Add-on toggle bar */}
					<div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-dashed">
						{ADD_ON_KEYS.map(({ key, label }) => (
							<button
								key={key}
								type="button"
								onClick={() =>
									onUpdate((current) => ({
										...current,
										addOns: {
											...current.addOns,
											[key]: !current.addOns[key],
										},
									}))
								}
								className={cn(
									"px-2 py-0.5 text-[11px] rounded-sm border transition-colors",
									query.addOns[key]
										? "bg-primary/10 border-primary/30 text-primary"
										: "bg-muted/40 border-transparent text-muted-foreground hover:text-foreground",
								)}
							>
								{label}
							</button>
						))}
					</div>

					{/* Expanded add-on sections */}
					<AddOnSections
						query={query}
						autocompleteValues={autocompleteValues}
						onUpdate={onUpdate}
					/>
				</div>
			)}
		</div>
	)
}

// ---------------------------------------------------------------------------
// TracesLogsBody
// ---------------------------------------------------------------------------

function TracesLogsBody({
	query,
	aggregateOptions,
	autocompleteValues,
	onUpdate,
	onAggregationChange,
}: {
	query: QueryBuilderQueryDraft
	aggregateOptions: Array<{ label: string; value: string }>
	autocompleteValues: AutocompleteValues
	onUpdate: (updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => void
	onAggregationChange: (aggregation: string) => void
}) {
	return (
		<>
			{/* Row 1: Where clause */}
			<div className="flex items-start gap-2">
				<WhereClauseEditor
					className="flex-1"
					rows={1}
					value={query.whereClause}
					dataSource={query.dataSource}
					values={autocompleteValues[query.dataSource]}
					onChange={(nextWhereClause) =>
						onUpdate((current) => ({
							...current,
							whereClause: nextWhereClause,
						}))
					}
					placeholder='service.name = "checkout" AND status.code = "Error"'
					textareaClassName="min-h-[32px] resize-y text-xs"
					ariaLabel={`Where clause for query ${query.name}`}
				/>
				{query.dataSource === "traces" && (
					<Select
						items={{ all: "All Spans", root: "Root Spans" }}
						value={query.whereClause.includes("root_only = true") ? "root" : "all"}
						onValueChange={(value) =>
							onUpdate((current) => {
								const stripped = current.whereClause
									.replace(/\s*AND\s*root_only\s*=\s*\w+/gi, "")
									.replace(/root_only\s*=\s*\w+\s*AND\s*/gi, "")
									.replace(/root_only\s*=\s*\w+/gi, "")
									.trim()
								const clause =
									value === "root"
										? stripped
											? `${stripped} AND root_only = true`
											: "root_only = true"
										: stripped
								return { ...current, whereClause: clause }
							})
						}
					>
						<SelectTrigger className="h-8 w-[120px] text-xs shrink-0">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Spans</SelectItem>
							<SelectItem value="root">Root Spans</SelectItem>
						</SelectContent>
					</Select>
				)}
			</div>

			{/* Row 2: Aggregation + interval */}
			<div className="flex items-center gap-2 flex-wrap">
				<Select
					items={aggregateOptions}
					value={query.aggregation}
					onValueChange={(value) => onAggregationChange(value ?? query.aggregation)}
				>
					<SelectTrigger className="h-8 w-[160px] text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{aggregateOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<span className="text-xs text-muted-foreground">every</span>

				<Input
					value={query.stepInterval}
					onChange={(event) =>
						onUpdate((current) => ({
							...current,
							stepInterval: event.target.value,
						}))
					}
					placeholder="Auto"
					className="h-8 w-20 text-xs"
				/>

				<span className="text-xs text-muted-foreground">seconds</span>
			</div>
		</>
	)
}

// ---------------------------------------------------------------------------
// MetricsBody
// ---------------------------------------------------------------------------

function MetricsBody({
	query,
	aggregateOptions,
	metricValue,
	metricSelectionOptions,
	onMetricSearch,
	autocompleteValues,
	onUpdate,
	onMetricSelectionChange,
	onAggregationChange,
}: {
	query: QueryBuilderQueryDraft
	aggregateOptions: Array<{ label: string; value: string }>
	metricValue: string | undefined
	metricSelectionOptions: MetricSelectionOption[]
	onMetricSearch?: (search: string) => void
	autocompleteValues: AutocompleteValues
	onUpdate: (updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => void
	onMetricSelectionChange: (selection: {
		metricName: string
		metricType: QueryBuilderMetricType
		isMonotonic: boolean
	}) => void
	onAggregationChange: (aggregation: string) => void
}) {
	return (
		<>
			{/* Row 1: Metric type + name */}
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground shrink-0">Metric</span>
				<Combobox
					value={metricValue ?? null}
					onValueChange={(value) => {
						const parsed = value ? parseMetricSelection(value) : null
						if (!parsed) return
						const selectedOption = metricSelectionOptions.find((o) => o.value === value)
						const isMonotonic = selectedOption?.isMonotonic ?? parsed.metricType === "sum"
						onMetricSelectionChange({
							metricName: parsed.metricName,
							metricType: parsed.metricType,
							isMonotonic,
						})
					}}
				>
					<ComboboxInput
						placeholder="Search metrics..."
						className="h-8 flex-1 text-xs"
						onChange={(e) => onMetricSearch?.(e.target.value)}
					/>
					<ComboboxContent>
						{metricSelectionOptions.length === 0 ? (
							<div className="py-4 text-center text-xs text-muted-foreground">
								No metrics found.
							</div>
						) : (
							<ComboboxList>
								{metricSelectionOptions.map((metric) => (
									<ComboboxItem key={metric.value} value={metric.value}>
										{metric.label}
									</ComboboxItem>
								))}
							</ComboboxList>
						)}
					</ComboboxContent>
				</Combobox>
			</div>

			{/* Row 2: Where clause */}
			<WhereClauseEditor
				rows={1}
				value={query.whereClause}
				dataSource={query.dataSource}
				values={autocompleteValues.metrics}
				onChange={(nextWhereClause) =>
					onUpdate((current) => ({
						...current,
						whereClause: nextWhereClause,
					}))
				}
				placeholder='service.name = "my-service"'
				textareaClassName="min-h-[32px] resize-y text-xs"
				ariaLabel={`Where clause for query ${query.name}`}
			/>

			{/* Row 3: AGGREGATE WITHIN TIME SERIES */}
			<div className="flex items-center gap-2 flex-wrap">
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
					Aggregate within time series
				</span>
				<Select
					items={aggregateOptions}
					value={query.aggregation}
					onValueChange={(value) => onAggregationChange(value ?? query.aggregation)}
				>
					<SelectTrigger className="h-8 w-24 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{aggregateOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<span className="text-xs text-muted-foreground">every</span>

				<Input
					value={query.stepInterval}
					onChange={(event) =>
						onUpdate((current) => ({
							...current,
							stepInterval: event.target.value,
						}))
					}
					placeholder="Auto"
					className="h-8 w-20 text-xs"
				/>

				<span className="text-xs text-muted-foreground">seconds</span>
			</div>

			{/* Row 4: AGGREGATE ACROSS TIME SERIES */}
			<div className="flex items-center gap-2 flex-wrap">
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
					Aggregate across time series
				</span>

				<Select
					items={aggregateOptions}
					value={query.aggregation}
					onValueChange={(value) => onAggregationChange(value ?? query.aggregation)}
				>
					<SelectTrigger className="h-8 w-24 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{aggregateOptions.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<span className="text-xs text-muted-foreground">by</span>

				<Combobox
					value={
						!query.addOns.groupBy ||
						query.groupBy.length === 0 ||
						(query.groupBy.length === 1 && query.groupBy[0] === "none")
							? "__none__"
							: (query.groupBy[0] ?? "__none__")
					}
					onValueChange={(value) => {
						if (!value) return
						onUpdate((current) => ({
							...current,
							groupBy: value === "__none__" ? [] : [value],
							addOns: { ...current.addOns, groupBy: value !== "__none__" },
						}))
					}}
				>
					<ComboboxInput placeholder="Search fields..." className="h-8 w-[220px] text-xs" />
					<ComboboxContent>
						<ComboboxList>
							<ComboboxItem value="__none__">Everything (no breakdown)</ComboboxItem>
							<ComboboxItem value="service.name">service.name</ComboboxItem>
							{(autocompleteValues.metrics?.attributeKeys ?? []).map((key) => (
								<ComboboxItem key={key} value={`attr.${key}`}>
									attr.{key}
								</ComboboxItem>
							))}
						</ComboboxList>
					</ComboboxContent>
				</Combobox>
			</div>
		</>
	)
}

// ---------------------------------------------------------------------------
// AddOnSections
// ---------------------------------------------------------------------------

function AddOnSections({
	query,
	autocompleteValues,
	onUpdate,
}: {
	query: QueryBuilderQueryDraft
	autocompleteValues: AutocompleteValues
	onUpdate: (updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => void
}) {
	const hasAny = Object.values(query.addOns).some(Boolean)
	if (!hasAny) return null

	return (
		<div className="space-y-2 pt-1">
			{query.addOns.groupBy && query.dataSource !== "metrics" && (
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground w-16 shrink-0">Group By</span>
					<GroupByMultiSelect
						value={query.groupBy}
						onChange={(value) => onUpdate((current) => ({ ...current, groupBy: value }))}
						dataSource={query.dataSource}
						attributeKeys={autocompleteValues[query.dataSource]?.attributeKeys}
					/>
				</div>
			)}

			{query.addOns.having && (
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground w-16 shrink-0">Having</span>
					<Input
						value={query.having}
						onChange={(event) =>
							onUpdate((current) => ({
								...current,
								having: event.target.value,
							}))
						}
						placeholder="count > 10"
						className="h-8 text-xs flex-1"
					/>
				</div>
			)}

			{query.addOns.orderBy && (
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground w-16 shrink-0">Order By</span>
					<Input
						value={query.orderBy}
						onChange={(event) =>
							onUpdate((current) => ({
								...current,
								orderBy: event.target.value,
							}))
						}
						placeholder="value"
						className="h-8 text-xs flex-1"
					/>
					<Select
						value={query.orderByDirection}
						onValueChange={(value) =>
							onUpdate((current) => ({
								...current,
								orderByDirection:
									value === "asc" || value === "desc" ? value : current.orderByDirection,
							}))
						}
					>
						<SelectTrigger className="h-8 w-20 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="desc">desc</SelectItem>
							<SelectItem value="asc">asc</SelectItem>
						</SelectContent>
					</Select>
				</div>
			)}

			{query.addOns.limit && (
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground w-16 shrink-0">Limit</span>
					<Input
						value={query.limit}
						onChange={(event) =>
							onUpdate((current) => ({
								...current,
								limit: event.target.value,
							}))
						}
						placeholder="10"
						className="h-8 w-24 text-xs"
						type="number"
						min={1}
					/>
				</div>
			)}

			{query.addOns.legend && (
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground w-16 shrink-0">Legend</span>
					<Input
						value={query.legend}
						onChange={(event) =>
							onUpdate((current) => ({
								...current,
								legend: event.target.value,
							}))
						}
						placeholder="Human-friendly series name"
						className="h-8 text-xs flex-1"
					/>
				</div>
			)}
		</div>
	)
}

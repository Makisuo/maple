import * as React from "react"

import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import { useMetricScopedAutocomplete } from "@/hooks/use-metric-scoped-autocomplete"
import { getMetricsAggregations, type QueryBuilderMetricType } from "@/lib/query-builder/model"

const GROUP_BY_NONE = "__none__"

export interface MetricQueryPatch {
	agg?: string
	where?: string
	groupBy?: string
	step?: string
	bd?: string
}

interface MetricQueryControlsProps {
	metricName: string
	metricType: QueryBuilderMetricType
	isMonotonic: boolean
	aggregation: string
	whereClause: string
	groupBy: string | undefined
	stepInterval: string
	startTime: string
	endTime: string
	onPatch: (patch: MetricQueryPatch) => void
}

/**
 * The structured query row for the metric detail page:
 * aggregation → where → group-by → step. Every change is written back to the
 * URL by the parent, so the whole query is shareable and reload-safe.
 */
export function MetricQueryControls({
	metricName,
	metricType,
	isMonotonic,
	aggregation,
	whereClause,
	groupBy,
	stepInterval,
	startTime,
	endTime,
	onPatch,
}: MetricQueryControlsProps) {
	const autocompleteValues = useAutocompleteValuesContext()
	const scopedAutocomplete = useMetricScopedAutocomplete({
		base: autocompleteValues.metrics,
		metricName,
		metricType,
		startTime,
		endTime,
	})

	const aggregateOptions = getMetricsAggregations(metricType, isMonotonic)

	// The where clause is typed continuously — keep it local and only commit to
	// the URL after the user pauses, so history isn't spammed per keystroke.
	const [localWhere, setLocalWhere] = React.useState(whereClause)
	const commitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	React.useEffect(() => {
		setLocalWhere(whereClause)
	}, [whereClause])
	const handleWhereChange = (next: string) => {
		setLocalWhere(next)
		if (commitTimer.current) clearTimeout(commitTimer.current)
		commitTimer.current = setTimeout(() => onPatch({ where: next }), 400)
	}
	React.useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)

	return (
		<div className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md border bg-card p-3">
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground shrink-0">Aggregate</span>
				<Select
					items={aggregateOptions}
					value={aggregation}
					onValueChange={(value) => onPatch({ agg: value ?? aggregation })}
				>
					<SelectTrigger className="h-8 w-28 text-xs">
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
			</div>

			<div className="flex min-w-64 flex-1 items-center gap-2">
				<span className="text-xs text-muted-foreground shrink-0">Where</span>
				<WhereClauseEditor
					rows={1}
					value={localWhere}
					dataSource="metrics"
					values={scopedAutocomplete.values}
					onActiveAttributeKey={scopedAutocomplete.onActiveAttributeKey}
					onChange={handleWhereChange}
					placeholder='http.route = "/api/users"'
					className="flex-1"
					textareaClassName="min-h-8 resize-y text-xs"
					ariaLabel={`Where clause for ${metricName}`}
					highlight
				/>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground shrink-0">Group by</span>
				<Combobox
					value={groupBy ?? GROUP_BY_NONE}
					itemToStringLabel={(value: string) =>
						value === GROUP_BY_NONE ? "Everything (no breakdown)" : value
					}
					onValueChange={(value) => {
						if (!value) return
						onPatch({ groupBy: value === GROUP_BY_NONE ? undefined : value })
					}}
				>
					<ComboboxInput placeholder="Search fields..." className="h-8 w-52 text-xs" />
					<ComboboxContent>
						<ComboboxList>
							<ComboboxItem value={GROUP_BY_NONE}>Everything (no breakdown)</ComboboxItem>
							<ComboboxItem value="service.name">service.name</ComboboxItem>
							{scopedAutocomplete.groupByKeys.map((key) => (
								<ComboboxItem key={key} value={`attr.${key}`}>
									attr.{key}
								</ComboboxItem>
							))}
						</ComboboxList>
					</ComboboxContent>
				</Combobox>
			</div>

			<StepIntervalInput stepInterval={stepInterval} onCommit={(step) => onPatch({ step })} />
		</div>
	)
}

/** Commits on blur/Enter so typing "300" doesn't fire three queries. */
function StepIntervalInput({
	stepInterval,
	onCommit,
}: {
	stepInterval: string
	onCommit: (step: string) => void
}) {
	const [local, setLocal] = React.useState(stepInterval)
	React.useEffect(() => {
		setLocal(stepInterval)
	}, [stepInterval])

	const commit = () => {
		if (local !== stepInterval) onCommit(local)
	}

	return (
		<div className="flex items-center gap-2">
			<span className="text-xs text-muted-foreground shrink-0">Every</span>
			<Input
				value={local}
				onChange={(event) => setLocal(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit()
				}}
				placeholder="Auto"
				className="h-8 w-20 text-xs"
				aria-label="Step interval"
			/>
			<span className="text-xs text-muted-foreground">sec</span>
		</div>
	)
}

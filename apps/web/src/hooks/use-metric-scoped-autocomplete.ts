import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getMetricAttributeKeysResultAtom,
	getMetricAttributeValuesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"

export type MetricScopedMetricType = "sum" | "gauge" | "histogram" | "exponential_histogram"

const METRIC_TYPES: ReadonlySet<string> = new Set(["sum", "gauge", "histogram", "exponential_histogram"])

interface UseMetricScopedAutocompleteOptions {
	/** Unscoped metrics autocomplete values from AutocompleteValuesProvider. */
	base: WhereClauseAutocompleteValues | undefined
	metricName: string | undefined
	metricType: string | undefined
	startTime?: string
	endTime?: string
}

/**
 * Overrides the org-wide metric attribute suggestions with ones scoped to the
 * selected metric. Falls back to the unscoped `base` values while no metric is
 * selected (or while the scoped fetch has no data yet is NOT a fallback — an
 * empty scoped result means the metric genuinely has no attributes).
 */
export function useMetricScopedAutocomplete({
	base,
	metricName,
	metricType,
	startTime,
	endTime,
}: UseMetricScopedAutocompleteOptions) {
	const [activeAttributeKey, setActiveAttributeKey] = React.useState<string | null>(null)

	const scopedType =
		metricType && METRIC_TYPES.has(metricType) ? (metricType as MetricScopedMetricType) : undefined
	const scoped = Boolean(metricName && scopedType)

	const keysResult = useAtomValue(
		scoped
			? getMetricAttributeKeysResultAtom({
					data: { startTime, endTime, metricName, metricType: scopedType },
				})
			: disabledResultAtom<{ data: { attributeKey: string; usageCount: number }[] }>(),
	)

	const valuesResult = useAtomValue(
		scoped && activeAttributeKey
			? getMetricAttributeValuesResultAtom({
					data: {
						startTime,
						endTime,
						attributeKey: activeAttributeKey,
						metricName,
						metricType: scopedType,
					},
				})
			: disabledResultAtom<{ data: { attributeValue: string; usageCount: number }[] }>(),
	)

	const attributeKeys = React.useMemo(
		() =>
			Result.builder(keysResult)
				.onSuccess((r) => r.data.map((row) => row.attributeKey))
				.orElse(() => []),
		[keysResult],
	)

	const attributeValues = React.useMemo(
		() =>
			activeAttributeKey
				? Result.builder(valuesResult)
						.onSuccess((r) => r.data.map((row) => row.attributeValue))
						.orElse(() => [])
				: [],
		[activeAttributeKey, valuesResult],
	)

	const values = React.useMemo(
		(): WhereClauseAutocompleteValues | undefined =>
			scoped ? { ...base, attributeKeys, attributeValues } : base,
		[scoped, base, attributeKeys, attributeValues],
	)

	const onActiveAttributeKey = React.useCallback((key: string | null) => {
		setActiveAttributeKey(key)
	}, [])

	return {
		values,
		groupByKeys: scoped ? attributeKeys : (base?.attributeKeys ?? []),
		onActiveAttributeKey,
	}
}

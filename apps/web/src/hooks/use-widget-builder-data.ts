import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import { type QueryBuilderMetricType } from "@/lib/query-builder/model"
import { resetAggregationForMetricType } from "@/lib/query-builder/model"
import { listMetricsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import { toNames } from "@/lib/query-builder/autocomplete-utils"

export interface MetricSelectionOption {
  value: string
  label: string
  isMonotonic: boolean
}

export function useWidgetBuilderData() {
  const { state, actions: { setState } } = useWidgetBuilder()
  const baseAutocompleteValues = useAutocompleteValuesContext()

  const [metricSearch, setMetricSearch] = React.useState("")
  const deferredMetricSearch = React.useDeferredValue(metricSearch)

  const hasMetricsQuery = state.queries.some((q) => q.dataSource === "metrics")

  const metricsResult = useAtomValue(
    hasMetricsQuery
      ? listMetricsResultAtom({ data: { limit: 100, search: deferredMetricSearch || undefined } })
      : disabledResultAtom(),
  )

  type MetricRow = { metricName: string; metricType: string; serviceName: string; isMonotonic: boolean }

  const metricRows = React.useMemo(
    (): MetricRow[] =>
      Result.builder(metricsResult)
        .onSuccess((response) => (response as { data: MetricRow[] }).data)
        .orElse(() => []),
    [metricsResult],
  )

  const metricSelectionOptions = React.useMemo(() => {
    const seen = new Set<string>()
    const options: MetricSelectionOption[] = []
    for (const row of metricRows) {
      if (
        row.metricType !== "sum" &&
        row.metricType !== "gauge" &&
        row.metricType !== "histogram" &&
        row.metricType !== "exponential_histogram"
      ) continue
      const value = `${row.metricName}::${row.metricType}`
      if (seen.has(value)) continue
      seen.add(value)
      options.push({ value, label: `${row.metricName} (${row.metricType})`, isMonotonic: row.isMonotonic })
    }
    return options
  }, [metricRows])

  // Augment base autocomplete values with metric-specific services
  const autocompleteValues = React.useMemo(() => {
    const metricServices = toNames(
      metricRows
        .map((row) => ({ name: row.serviceName }))
        .filter((row) => row.name.trim()),
    )

    return {
      traces: baseAutocompleteValues.traces,
      logs: baseAutocompleteValues.logs,
      metrics: {
        ...baseAutocompleteValues.metrics,
        services: metricServices,
      },
    }
  }, [baseAutocompleteValues, metricRows])

  // Apply default metric selection when metric options first become available
  const appliedMetricDefaultRef = React.useRef(false)
  if (metricSelectionOptions.length > 0 && !appliedMetricDefaultRef.current) {
    const [defaultMetricName, defaultMetricTypeRaw] = metricSelectionOptions[0].value.split("::")
    const defaultMetricType = defaultMetricTypeRaw as QueryBuilderMetricType
    const needsDefault = state.queries.some(
      (query) => query.dataSource === "metrics" && !query.metricName && defaultMetricName && defaultMetricType,
    )
    if (needsDefault) {
      appliedMetricDefaultRef.current = true
      setState((current) => {
        let changed = false
        const queries = current.queries.map((query) => {
          if (query.dataSource !== "metrics" || query.metricName || !defaultMetricName || !defaultMetricType) return query
          changed = true
          const defaultIsMonotonic = metricSelectionOptions[0]?.isMonotonic ?? (defaultMetricType === "sum")
          return {
            ...query,
            metricName: defaultMetricName,
            metricType: defaultMetricType,
            isMonotonic: defaultIsMonotonic,
            aggregation: resetAggregationForMetricType(query.aggregation, defaultMetricType, defaultIsMonotonic),
          }
        })
        return changed ? { ...current, queries } : current
      })
    }
  }

  return {
    autocompleteValues,
    activateAutocomplete: baseAutocompleteValues.activate,
    metricSelectionOptions,
    metricSearch,
    setMetricSearch,
  }
}

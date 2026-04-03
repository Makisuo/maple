import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useAutocompleteContext } from "@/hooks/use-autocomplete-context"
import { QUERY_BUILDER_METRIC_TYPES, type QueryBuilderMetricType } from "@/lib/query-builder/model"
import { resetAggregationForMetricType } from "@/lib/query-builder/model"
import {
  getLogsFacetsResultAtom,
  getMetricAttributeKeysResultAtom,
  getResourceAttributeKeysResultAtom,
  getResourceAttributeValuesResultAtom,
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
  getTracesFacetsResultAtom,
  listMetricsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"

export interface MetricSelectionOption {
  value: string
  label: string
  isMonotonic: boolean
}

export function useWidgetBuilderData() {
  const { state, actions: { setState } } = useWidgetBuilder()
  const {
    activeAttributeKey,
    activeResourceAttributeKey,
  } = useAutocompleteContext()

  const {
    state: { resolvedTimeRange: resolvedTime },
  } = useDashboardTimeRange()

  const [metricSearch, setMetricSearch] = React.useState("")
  const deferredMetricSearch = React.useDeferredValue(metricSearch)

  const metricsResult = useAtomValue(
    listMetricsResultAtom({ data: { limit: 100, search: deferredMetricSearch || undefined } }),
  )

  const tracesFacetsResult = useAtomValue(
    getTracesFacetsResultAtom({ data: {} }),
  )

  const logsFacetsResult = useAtomValue(
    getLogsFacetsResultAtom({ data: {} }),
  )

  const spanAttributeKeysResult = useAtomValue(
    getSpanAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const spanAttributeValuesResult = useAtomValue(
    getSpanAttributeValuesResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
        attributeKey: activeAttributeKey ?? "",
      },
    }),
  )

  const metricAttributeKeysResult = useAtomValue(
    getMetricAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const resourceAttributeKeysResult = useAtomValue(
    getResourceAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const resourceAttributeValuesResult = useAtomValue(
    getResourceAttributeValuesResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
        attributeKey: activeResourceAttributeKey ?? "",
      },
    }),
  )

  const attributeKeys = React.useMemo(
    () =>
      Result.builder(spanAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [spanAttributeKeysResult],
  )

  const attributeValues = React.useMemo(
    () =>
      activeAttributeKey
        ? Result.builder(spanAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeAttributeKey, spanAttributeValuesResult],
  )

  const resourceAttributeKeys = React.useMemo(
    () =>
      Result.builder(resourceAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [resourceAttributeKeysResult],
  )

  const resourceAttributeValues = React.useMemo(
    () =>
      activeResourceAttributeKey
        ? Result.builder(resourceAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeResourceAttributeKey, resourceAttributeValuesResult],
  )

  const metricAttributeKeys = React.useMemo(
    () =>
      Result.builder(metricAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [metricAttributeKeysResult],
  )

  const metricRows = React.useMemo(
    () =>
      Result.builder(metricsResult)
        .onSuccess((response) => response.data)
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

  const autocompleteValues = React.useMemo(() => {
    const tracesFacets = Result.builder(tracesFacetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({
        services: [],
        spanNames: [],
        deploymentEnvs: [],
      }))

    const logsFacets = Result.builder(logsFacetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({
        services: [],
        severities: [],
      }))

    const toNames = (items: Array<{ name: string }>): string[] => {
      const seen = new Set<string>()
      const values: string[] = []
      for (const item of items) {
        const next = item.name.trim()
        if (!next || seen.has(next)) continue
        seen.add(next)
        values.push(next)
      }
      return values
    }

    const metricServices = toNames(
      metricRows
        .map((row) => ({ name: row.serviceName }))
        .filter((row) => row.name.trim()),
    )

    return {
      traces: {
        services: toNames(tracesFacets.services),
        spanNames: toNames(tracesFacets.spanNames),
        environments: toNames(tracesFacets.deploymentEnvs),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      },
      logs: {
        services: toNames(logsFacets.services),
        severities: toNames(logsFacets.severities),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      },
      metrics: {
        services: metricServices,
        metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
        attributeKeys: metricAttributeKeys,
      },
    }
  }, [logsFacetsResult, metricRows, tracesFacetsResult, attributeKeys, attributeValues, resourceAttributeKeys, resourceAttributeValues, metricAttributeKeys])

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
    metricSelectionOptions,
    metricSearch,
    setMetricSearch,
  }
}

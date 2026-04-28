import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { AutocompleteKeysProvider, useAutocompleteContext } from "@/hooks/use-autocomplete-context"
import {
	getLogsFacetsResultAtom,
	getMetricAttributeKeysResultAtom,
	getResourceAttributeKeysResultAtom,
	getResourceAttributeValuesResultAtom,
	getSpanAttributeKeysResultAtom,
	getSpanAttributeValuesResultAtom,
	getTracesFacetsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { QUERY_BUILDER_METRIC_TYPES } from "@/lib/query-builder/model"
import { toNames } from "@/lib/query-builder/autocomplete-utils"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AutocompleteValuesContextType {
	traces: WhereClauseAutocompleteValues
	logs: WhereClauseAutocompleteValues
	metrics: WhereClauseAutocompleteValues
	/** Raw span attribute keys for GroupBy, column selectors, etc. */
	attributeKeys: string[]
	resourceAttributeKeys: string[]
	metricAttributeKeys: string[]
	/** When lazy, call this to trigger fetching autocomplete data */
	activate?: () => void
}

const AutocompleteValuesCtx = React.createContext<AutocompleteValuesContextType | null>(null)

export function useAutocompleteValuesContext(): AutocompleteValuesContextType {
	const ctx = React.use(AutocompleteValuesCtx)
	if (!ctx) {
		throw new Error("useAutocompleteValuesContext must be used inside AutocompleteValuesProvider")
	}
	return ctx
}

export function useAutocompleteValuesContextOptional(): AutocompleteValuesContextType | null {
	return React.use(AutocompleteValuesCtx)
}

// ---------------------------------------------------------------------------
// Inner component (must be inside AutocompleteKeysProvider)
// ---------------------------------------------------------------------------

function AutocompleteValuesInner({
	startTime,
	endTime,
	children,
}: {
	startTime?: string
	endTime?: string
	children: React.ReactNode
}) {
	const { activeAttributeKey, activeResourceAttributeKey } = useAutocompleteContext()

	// --- Facets ---
	const tracesFacetsResult = useAtomValue(getTracesFacetsResultAtom({ data: { startTime, endTime } }))
	const logsFacetsResult = useAtomValue(getLogsFacetsResultAtom({ data: { startTime, endTime } }))

	// --- Attribute keys ---
	const spanAttributeKeysResult = useAtomValue(
		getSpanAttributeKeysResultAtom({ data: { startTime, endTime } }),
	)
	const resourceAttributeKeysResult = useAtomValue(
		getResourceAttributeKeysResultAtom({ data: { startTime, endTime } }),
	)
	const metricAttributeKeysResult = useAtomValue(
		getMetricAttributeKeysResultAtom({ data: { startTime, endTime } }),
	)

	// --- Attribute values (lazy, driven by active key) ---
	const spanAttributeValuesResult = useAtomValue(
		getSpanAttributeValuesResultAtom({
			data: { startTime, endTime, attributeKey: activeAttributeKey ?? "" },
		}),
	)
	const resourceAttributeValuesResult = useAtomValue(
		getResourceAttributeValuesResultAtom({
			data: { startTime, endTime, attributeKey: activeResourceAttributeKey ?? "" },
		}),
	)

	// --- Derived arrays ---
	const attributeKeys = React.useMemo(
		() =>
			Result.builder(spanAttributeKeysResult)
				.onSuccess((r) => r.data.map((row) => row.attributeKey))
				.orElse(() => []),
		[spanAttributeKeysResult],
	)

	const attributeValues = React.useMemo(
		() =>
			activeAttributeKey
				? Result.builder(spanAttributeValuesResult)
						.onSuccess((r) => r.data.map((row) => row.attributeValue))
						.orElse(() => [])
				: [],
		[activeAttributeKey, spanAttributeValuesResult],
	)

	const resourceAttributeKeys = React.useMemo(
		() =>
			Result.builder(resourceAttributeKeysResult)
				.onSuccess((r) => r.data.map((row) => row.attributeKey))
				.orElse(() => []),
		[resourceAttributeKeysResult],
	)

	const resourceAttributeValues = React.useMemo(
		() =>
			activeResourceAttributeKey
				? Result.builder(resourceAttributeValuesResult)
						.onSuccess((r) => r.data.map((row) => row.attributeValue))
						.orElse(() => [])
				: [],
		[activeResourceAttributeKey, resourceAttributeValuesResult],
	)

	const metricAttributeKeys = React.useMemo(
		() =>
			Result.builder(metricAttributeKeysResult)
				.onSuccess((r) => r.data.map((row) => row.attributeKey))
				.orElse(() => []),
		[metricAttributeKeysResult],
	)

	// --- Assemble autocomplete values ---
	const value = React.useMemo((): AutocompleteValuesContextType => {
		const tracesFacets = Result.builder(tracesFacetsResult)
			.onSuccess((r) => r.data)
			.orElse(() => ({
				services: [],
				spanNames: [],
				deploymentEnvs: [],
				httpMethods: [],
				httpStatusCodes: [],
			}))

		const logsFacets = Result.builder(logsFacetsResult)
			.onSuccess((r) => r.data)
			.orElse(() => ({
				services: [],
				severities: [],
			}))

		return {
			traces: {
				services: toNames(tracesFacets.services ?? []),
				spanNames: toNames(tracesFacets.spanNames ?? []),
				environments: toNames(tracesFacets.deploymentEnvs ?? []),
				httpMethods: toNames(tracesFacets.httpMethods ?? []),
				httpStatusCodes: toNames(tracesFacets.httpStatusCodes ?? []),
				attributeKeys,
				attributeValues,
				resourceAttributeKeys,
				resourceAttributeValues,
			},
			logs: {
				services: toNames(logsFacets.services ?? []),
				severities: toNames(logsFacets.severities ?? []),
				attributeKeys,
				attributeValues,
				resourceAttributeKeys,
				resourceAttributeValues,
			},
			metrics: {
				metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
				attributeKeys: metricAttributeKeys,
			},
			attributeKeys,
			resourceAttributeKeys,
			metricAttributeKeys,
		}
	}, [
		tracesFacetsResult,
		logsFacetsResult,
		attributeKeys,
		attributeValues,
		resourceAttributeKeys,
		resourceAttributeValues,
		metricAttributeKeys,
	])

	return <AutocompleteValuesCtx value={value}>{children}</AutocompleteValuesCtx>
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

const emptyAutocompleteValues: AutocompleteValuesContextType = {
	traces: {
		services: [],
		spanNames: [],
		environments: [],
		httpMethods: [],
		httpStatusCodes: [],
		attributeKeys: [],
		attributeValues: [],
		resourceAttributeKeys: [],
		resourceAttributeValues: [],
	},
	logs: {
		services: [],
		severities: [],
		attributeKeys: [],
		attributeValues: [],
		resourceAttributeKeys: [],
		resourceAttributeValues: [],
	},
	metrics: { metricTypes: [...QUERY_BUILDER_METRIC_TYPES], attributeKeys: [] },
	attributeKeys: [],
	resourceAttributeKeys: [],
	metricAttributeKeys: [],
}

export function AutocompleteValuesProvider({
	startTime,
	endTime,
	lazy = false,
	children,
}: {
	startTime?: string
	endTime?: string
	/** When true, defer all fetches until `activate()` is called */
	lazy?: boolean
	children: React.ReactNode
}) {
	const [activated, setActivated] = React.useState(!lazy)
	const activate = React.useCallback(() => setActivated(true), [])

	if (!activated) {
		const value = { ...emptyAutocompleteValues, activate }
		return <AutocompleteValuesCtx value={value}>{children}</AutocompleteValuesCtx>
	}

	return (
		<AutocompleteKeysProvider>
			<AutocompleteValuesInner startTime={startTime} endTime={endTime}>
				{children}
			</AutocompleteValuesInner>
		</AutocompleteKeysProvider>
	)
}

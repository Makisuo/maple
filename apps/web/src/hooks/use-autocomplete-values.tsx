import * as React from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { AutocompleteKeysProvider, useAutocompleteContext } from "@/hooks/use-autocomplete-context"
import {
	getLogsFacetsResultAtom,
	getMetricAttributeKeysResultAtom,
	getResourceAttributeKeysResultAtom,
	getResourceAttributeValuesResultAtom,
	getSpanAttributeKeysResultAtom,
	getSpanAttributeValuesResultAtom,
	getTracesFacetsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
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

/**
 * Subscribe to `atom` only once `enabled` is true; until then read a static
 * idle atom so no warehouse query fires. Keeps hook order stable, which lets
 * the lazy provider keep one component tree across activation — swapping the
 * tree shape instead would remount every descendant (and e.g. close the
 * advanced-filter dialog the moment it activates the provider).
 */
function useGatedAtomValue<A, E>(
	atom: Atom.Atom<Result.Result<A, E>>,
	enabled: boolean,
): Result.Result<A, E> {
	const idle = React.useMemo(() => Atom.make<Result.Result<A, E>>(Result.initial()), [])
	return useAtomValue(enabled ? atom : idle)
}

function AutocompleteValuesInner({
	startTime,
	endTime,
	activated,
	activate,
	children,
}: {
	startTime?: string
	endTime?: string
	activated: boolean
	activate: () => void
	children: React.ReactNode
}) {
	const { activeAttributeKey, activeResourceAttributeKey } = useAutocompleteContext()

	// --- Facets ---
	const tracesFacetsResult = useGatedAtomValue(
		getTracesFacetsResultAtom({ data: { startTime, endTime } }),
		activated,
	)
	const logsFacetsResult = useGatedAtomValue(
		getLogsFacetsResultAtom({ data: { startTime, endTime } }),
		activated,
	)

	// --- Attribute keys ---
	const spanAttributeKeysResult = useGatedAtomValue(
		getSpanAttributeKeysResultAtom({ data: { startTime, endTime } }),
		activated,
	)
	const resourceAttributeKeysResult = useGatedAtomValue(
		getResourceAttributeKeysResultAtom({ data: { startTime, endTime } }),
		activated,
	)
	const metricAttributeKeysResult = useGatedAtomValue(
		getMetricAttributeKeysResultAtom({ data: { startTime, endTime } }),
		activated,
	)

	// --- Attribute values (lazy, driven by active key) ---
	const spanAttributeValuesResult = useGatedAtomValue(
		getSpanAttributeValuesResultAtom({
			data: { startTime, endTime, attributeKey: activeAttributeKey ?? "" },
		}),
		activated,
	)
	const resourceAttributeValuesResult = useGatedAtomValue(
		getResourceAttributeValuesResultAtom({
			data: { startTime, endTime, attributeKey: activeResourceAttributeKey ?? "" },
		}),
		activated,
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
			activate,
		}
	}, [
		tracesFacetsResult,
		logsFacetsResult,
		attributeKeys,
		attributeValues,
		resourceAttributeKeys,
		resourceAttributeValues,
		metricAttributeKeys,
		activate,
	])

	return <AutocompleteValuesCtx value={value}>{children}</AutocompleteValuesCtx>
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

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

	// One stable tree for both states — activation only flips which atoms the
	// inner component subscribes to (see useGatedAtomValue). Swapping the
	// wrapper structure here would remount all children on activate().
	return (
		<AutocompleteKeysProvider>
			<AutocompleteValuesInner
				startTime={startTime}
				endTime={endTime}
				activated={activated}
				activate={activate}
			>
				{children}
			</AutocompleteValuesInner>
		</AutocompleteKeysProvider>
	)
}

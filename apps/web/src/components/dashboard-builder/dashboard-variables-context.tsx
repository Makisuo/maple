// ---------------------------------------------------------------------------
// Dashboard variables
//
// Grafana-style dashboard variables: definitions live on the dashboard
// document, the *selected* values live in URL search params (`?var-service=api`)
// so views are shareable. This provider resolves each variable's current value
// (URL → default → All → first loaded option) and loads dropdown options for
// query-type variables from the existing facet/attribute-value atoms.
//
// Widgets consume the resolved values through `useDashboardVariablesOptional`
// inside `useWidgetDataSource`, where `$name` references in widget params are
// interpolated before the query fires.
// ---------------------------------------------------------------------------

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import {
	getLogsFacetValuesResultAtom,
	getResourceAttributeValuesResultAtom,
	getSpanAttributeValuesResultAtom,
	getTracesFacetValuesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { ALL_VALUE, type VariableValues } from "@/lib/dashboard-variables/interpolate"
import type { DashboardVariable } from "./types"
import { useDashboardTimeRange } from "./dashboard-providers"

export interface VariableOptionsState {
	options: string[]
	loading: boolean
}

export interface DashboardVariablesContextValue {
	variables: DashboardVariable[]
	/** Resolved value per variable name; `undefined` while a query variable's options are still loading. */
	values: VariableValues
	optionsByName: Record<string, VariableOptionsState>
	setValue: (name: string, value: string) => void
}

const DashboardVariablesContext = createContext<DashboardVariablesContextValue | null>(null)

const EMPTY_CONTEXT: DashboardVariablesContextValue = {
	variables: [],
	values: {},
	optionsByName: {},
	setValue: () => undefined,
}

type ResolvedTime = { startTime: string; endTime: string }

type FacetItem = { name: string; count: number }

const NO_OPTIONS: VariableOptionsState = { options: [], loading: false }
const LOADING_OPTIONS: VariableOptionsState = { options: [], loading: true }

function fromFacetItems(items: ReadonlyArray<FacetItem> | undefined): VariableOptionsState {
	return { options: (items ?? []).map((item) => item.name), loading: false }
}

// Variable facet id → traces facets dimension (the `facetType` the engine emits).
const TRACES_FACET_BY_SOURCE = {
	service: "service",
	environment: "deploymentEnv",
	span_name: "spanName",
	http_method: "httpMethod",
	http_status_code: "httpStatus",
} as const

// Reads the options for one variable inside the derived options atom. Query
// variables subscribe to the underlying facet / attribute-value family atoms
// (deduped by their encoded input key), so several variables sharing a source
// share one fetch.
function readVariableOptions(
	get: Atom.AtomContext,
	variable: DashboardVariable,
	time: ResolvedTime | null,
): VariableOptionsState {
	if (variable.type === "custom") {
		return { options: variable.options.map((option) => option.value), loading: false }
	}
	if (variable.type === "textbox") {
		return NO_OPTIONS
	}

	if (!time) return LOADING_OPTIONS
	const window = { startTime: time.startTime, endTime: time.endTime }

	const source = variable.source
	if (source.kind === "attribute") {
		const atom =
			source.scope === "resource"
				? getResourceAttributeValuesResultAtom({ data: { ...window, attributeKey: source.attributeKey } })
				: getSpanAttributeValuesResultAtom({ data: { ...window, attributeKey: source.attributeKey } })
		const result = get(atom)
		if (!Result.isSuccess(result)) {
			return Result.isFailure(result) ? NO_OPTIONS : LOADING_OPTIONS
		}
		return {
			options: result.value.data.map((row) => row.attributeValue),
			loading: false,
		}
	}

	// Facet variables fetch only their one dimension (the facets query compiles
	// a single UNION branch server-side) — never the full multi-facet scan the
	// traces/logs sidebars run.
	if (source.facet === "log_severity") {
		const result = get(getLogsFacetValuesResultAtom({ data: { ...window, facet: "severity" } }))
		if (!Result.isSuccess(result)) {
			return Result.isFailure(result) ? NO_OPTIONS : LOADING_OPTIONS
		}
		return fromFacetItems(result.value.data)
	}

	const result = get(
		getTracesFacetValuesResultAtom({ data: { ...window, facet: TRACES_FACET_BY_SOURCE[source.facet] } }),
	)
	if (!Result.isSuccess(result)) {
		return Result.isFailure(result) ? NO_OPTIONS : LOADING_OPTIONS
	}
	return fromFacetItems(result.value.data)
}

// Derived options atom per (definitions, time window). Keyed on the serialized
// inputs so edits to variable definitions (same array identity is not
// guaranteed by the store) rebuild it, while unrelated re-renders reuse the
// same atom instance. The key carries everything the atom body reads, so it
// never closes over component state.
const variableOptionsAtomFamily = Atom.family((key: string) => {
	const { definitions, time } = JSON.parse(key) as {
		definitions: DashboardVariable[]
		time: ResolvedTime | null
	}
	return Atom.make((get): Record<string, VariableOptionsState> => {
		const byName: Record<string, VariableOptionsState> = {}
		for (const variable of definitions) {
			byName[variable.name] = readVariableOptions(get, variable, time)
		}
		return byName
	})
})

// URL value → declared default → All (when enabled) → first loaded option.
// Returns `undefined` while a query variable's options are still loading and
// nothing else pins a value — consumers gate widget fetches on that.
function resolveValue(
	variable: DashboardVariable,
	urlValue: string | undefined,
	options: VariableOptionsState,
): string | undefined {
	const allEnabled = variable.includeAll === true
	if (urlValue !== undefined && urlValue !== "") {
		if (urlValue === ALL_VALUE) {
			if (allEnabled) return ALL_VALUE
		} else {
			return urlValue
		}
	}
	if (variable.defaultValue !== undefined && variable.defaultValue !== "") {
		return variable.defaultValue
	}
	if (variable.type === "textbox") return ""
	if (allEnabled) return ALL_VALUE
	if (options.options.length > 0) return options.options[0]
	// No options yet: still loading for query variables, permanently empty for
	// custom variables with an empty options list.
	return options.loading ? undefined : ""
}

export function DashboardVariablesProvider({
	variables,
	urlValues,
	onValueChange,
	children,
}: {
	variables: DashboardVariable[] | undefined
	/** `var-*` search params with the prefix stripped, coerced to strings. */
	urlValues: Record<string, string>
	onValueChange: (name: string, value: string) => void
	children: ReactNode
}) {
	const definitions = useMemo(() => variables ?? [], [variables])
	const {
		state: { resolvedTimeRange },
	} = useDashboardTimeRange()

	const optionsAtom = variableOptionsAtomFamily(
		JSON.stringify({
			definitions,
			time: resolvedTimeRange
				? { startTime: resolvedTimeRange.startTime, endTime: resolvedTimeRange.endTime }
				: null,
		}),
	)
	const optionsByName = useAtomValue(optionsAtom)

	const values = useMemo(() => {
		const resolved: VariableValues = {}
		for (const variable of definitions) {
			const value = resolveValue(
				variable,
				urlValues[variable.name],
				optionsByName[variable.name] ?? NO_OPTIONS,
			)
			if (value === undefined) continue
			resolved[variable.name] = {
				value,
				isAll: value === ALL_VALUE,
				options: optionsByName[variable.name]?.options ?? [],
			}
		}
		return resolved
	}, [definitions, urlValues, optionsByName])

	const setValue = useCallback(
		(name: string, value: string) => {
			if (urlValues[name] === value) return
			onValueChange(name, value)
		},
		[urlValues, onValueChange],
	)

	const contextValue = useMemo(
		() => ({ variables: definitions, values, optionsByName, setValue }),
		[definitions, values, optionsByName, setValue],
	)

	return (
		<DashboardVariablesContext.Provider value={contextValue}>
			{children}
		</DashboardVariablesContext.Provider>
	)
}

export function useDashboardVariables(): DashboardVariablesContextValue {
	const context = useContext(DashboardVariablesContext)
	return context ?? EMPTY_CONTEXT
}

/**
 * Variant for surfaces that may render outside a dashboard page (widget
 * builder preview, alert previews): returns `null` when no provider is
 * mounted so callers can skip variable handling entirely.
 */
export function useDashboardVariablesOptional(): DashboardVariablesContextValue | null {
	return useContext(DashboardVariablesContext)
}

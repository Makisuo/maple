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

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import {
	getLogsFacetValuesResultAtom,
	getResourceAttributeValuesResultAtom,
	getSpanAttributeValuesResultAtom,
	getTracesFacetValuesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import {
	ALL_VALUE,
	dashboardVariableOptionsQuery,
	resolveDashboardVariableValue,
	type DashboardVariableOptionsState,
	type VariableValues,
} from "@maple/query-engine"
import type { DashboardVariable } from "./types"
import { useDashboardTimeRange } from "./dashboard-providers"

export interface VariableOptionsState extends DashboardVariableOptionsState {
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

// Reads the options for one variable inside the derived options atom. Query
// variables subscribe to the underlying facet / attribute-value family atoms
// (deduped by their encoded input key), so several variables sharing a source
// share one fetch. *Which* query lists a variable's options is decided by
// `dashboardVariableOptionsQuery` — the same answer the share API acts on
// server-side — so a share cannot list different options than the board.
function readVariableOptions(
	get: Atom.AtomContext,
	variable: DashboardVariable,
	time: ResolvedTime | null,
): VariableOptionsState {
	if (variable.type === "custom") {
		return { options: variable.options.map((option) => option.value), loading: false }
	}
	const query = dashboardVariableOptionsQuery(variable)
	if (query === null) return NO_OPTIONS

	if (!time) return LOADING_OPTIONS
	const window = { startTime: time.startTime, endTime: time.endTime }

	if (query.kind === "attributeValues") {
		const atom =
			query.scope === "resource"
				? getResourceAttributeValuesResultAtom({
						data: { ...window, attributeKey: query.attributeKey },
					})
				: getSpanAttributeValuesResultAtom({ data: { ...window, attributeKey: query.attributeKey } })
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
	if (query.source === "logs") {
		const result = get(
			getLogsFacetValuesResultAtom({ data: { ...window, facet: query.facet ?? "severity" } }),
		)
		if (!Result.isSuccess(result)) {
			return Result.isFailure(result) ? NO_OPTIONS : LOADING_OPTIONS
		}
		return fromFacetItems(result.value.data)
	}

	const result = get(
		getTracesFacetValuesResultAtom({ data: { ...window, facet: query.facet ?? "service" } }),
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
	// SAFETY: The only caller below creates this key from the matching definitions/time object.
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

// URL value → declared default → All (when enabled) → first loaded option —
// the shared ladder (`resolveDashboardVariableValue`), so the share API resolves
// a variable to the same value the board does. Returns `undefined` while a
// query variable's options are still loading and nothing else pins a value —
// consumers gate widget fetches on that.
const resolveValue = resolveDashboardVariableValue

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

/**
 * Variables that were resolved elsewhere — the share page, whose values come
 * back from the share API after the board's ladder ran server-side. Nothing to
 * load and nothing to change, so no options and a no-op setter; what it gives
 * the tiles is the same `values` map the signed-in provider does, which is what
 * `WidgetShell` interpolates titles with.
 */
export function ResolvedDashboardVariablesProvider({
	values,
	children,
}: {
	values: VariableValues
	children: ReactNode
}) {
	const contextValue = useMemo<DashboardVariablesContextValue>(
		() => ({ variables: [], values, optionsByName: {}, setValue: () => undefined }),
		[values],
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

import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { AttributesProvider } from "@maple/ui/components/attributes"
import { applyAttributeFilterAction, type AttributeScope } from "@/lib/traces/attribute-filter-actions"

/**
 * Gives the attribute rows inside it a "Filter" / "Exclude" pair that opens the trace list scoped
 * to that exact key and value.
 *
 * The span detail lives on `/traces/$traceId`, whose own search schema is just `spanId` and `t` —
 * the referring list's filters ride through as unvalidated query params. Rather than reach into
 * that untyped bag, the action starts a fresh trace-list query carrying only this attribute and
 * the time range it was viewed at. Predictable, and the same thing "filter by this value" does
 * from a detail view elsewhere.
 *
 * Nested inside the root `AttributesProvider`, which keeps supplying `highlightJson` and
 * `renderValue` — the provider merges with whatever is already in scope.
 */
export function TraceAttributeFilterProvider({
	scope,
	timeRange,
	children,
}: {
	scope: AttributeScope
	/** The window the span was viewed at, so the list opens on the same range. */
	timeRange?: { startTime?: string; endTime?: string; timePreset?: string }
	children: React.ReactNode
}) {
	const navigate = useNavigate()

	const onFilterByAttribute = React.useCallback(
		({
			attrKey,
			value,
			action,
		}: Parameters<
			NonNullable<React.ComponentProps<typeof AttributesProvider>["onFilterByAttribute"]>
		>[0]) => {
			const filters = applyAttributeFilterAction({}, { scope, attrKey, value, action })
			navigate({
				to: "/traces",
				search: {
					...timeRange,
					...filters,
					attributeFilters: filters.attributeFilters?.map((entry) => ({ ...entry })),
					resourceAttributeFilters: filters.resourceAttributeFilters?.map((entry) => ({
						...entry,
					})),
				},
			})
		},
		[navigate, scope, timeRange],
	)

	return <AttributesProvider onFilterByAttribute={onFilterByAttribute}>{children}</AttributesProvider>
}

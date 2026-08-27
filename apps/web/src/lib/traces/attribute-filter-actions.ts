import type { AttributeFilterAction } from "@maple/ui/components/attributes"

/** The two attribute maps a span carries. Which one a key came from is not readable from the key —
 *  `service.name` is a resource attribute, `http.method` is a span one — so the section that
 *  rendered it passes its own scope in. */
export type AttributeScope = "span" | "resource"

export interface AttributeFilterEntry {
	key: string
	value: string
	negated?: boolean
}

export interface TraceAttributeFilterSearch {
	attributeFilters?: ReadonlyArray<AttributeFilterEntry>
	resourceAttributeFilters?: ReadonlyArray<AttributeFilterEntry>
}

export function attributeFilterParam(scope: AttributeScope): "attributeFilters" | "resourceAttributeFilters" {
	return scope === "resource" ? "resourceAttributeFilters" : "attributeFilters"
}

/**
 * The trace-list search that one value-level action produces.
 *
 * `only` and `include` are the same operation: an attribute filter is a single key/value pair, so
 * "only this value" is already what adding it means — unlike a facet section, which can hold
 * several ticked values for one dimension.
 *
 * Re-applying the opposite polarity on the same pair replaces it rather than stacking
 * `= x AND != x`, which matches nothing.
 */
export function applyAttributeFilterAction(
	search: TraceAttributeFilterSearch,
	input: { scope: AttributeScope; attrKey: string; value: string; action: AttributeFilterAction },
): TraceAttributeFilterSearch {
	const param = attributeFilterParam(input.scope)
	const current = search[param] ?? []
	const rest = current.filter((entry) => !(entry.key === input.attrKey && entry.value === input.value))
	return {
		...search,
		[param]: [
			...rest,
			{
				key: input.attrKey,
				value: input.value,
				negated: input.action === "exclude" || undefined,
			},
		],
	}
}

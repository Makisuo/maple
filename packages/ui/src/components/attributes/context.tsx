"use client"

import * as React from "react"

/**
 * Cross-cutting configuration for the shared attribute renderers
 * (`CopyableValue`, `CollapsibleJsonValue`, `AttributesTable`, `LogAttributeChip`).
 *
 * Both are optional so `@maple/ui` stays free of app-level deps (sugar-high).
 * Copy feedback is no longer injected here — `useCopy` owns it. Apps wire the
 * rest once at the root via `AttributesProvider`:
 *   - `highlightJson` turns a JSON string into highlighted HTML. When omitted,
 *     JSON renders as plain pre-formatted text.
 *   - `renderValue` lets apps enrich specific keys (e.g. wrap a commit-SHA in a
 *     hover card) without `@maple/ui` depending on app-level components. Return
 *     null/undefined to fall back to the default copyable text. JSON values are
 *     never passed through — they always use the collapsible renderer.
 */
/** What a value-level filter action does to the current query. */
export type AttributeFilterAction = "include" | "exclude" | "only"

export interface AttributesConfig {
	highlightJson?: (json: string) => string
	renderValue?: (attrKey: string, value: string) => React.ReactNode | null | undefined
	/**
	 * Applies a filter built from one attribute value. When supplied, every attribute row grows
	 * hover actions for it.
	 *
	 * This is the affordance people actually reach for — "this one endpoint is noise" starts from
	 * the row in front of them, not from hunting the facet in a sidebar. It lives here rather than
	 * on the row chips: those render a dozen per row across ~28 live rows in a virtualized list,
	 * where mounting a menu per chip more than doubled render time. The detail panel has no such
	 * constraint.
	 *
	 * Return `false` (or omit the handler) for a key the surface cannot filter on, and the row
	 * shows no actions.
	 */
	onFilterByAttribute?: (input: { attrKey: string; value: string; action: AttributeFilterAction }) => void
	/** Whether a given key is filterable on this surface. Defaults to all keys when omitted. */
	canFilterAttribute?: (attrKey: string) => boolean
}

const AttributesConfigContext = React.createContext<AttributesConfig>({})

export function AttributesProvider({
	children,
	highlightJson,
	renderValue,
	onFilterByAttribute,
	canFilterAttribute,
}: AttributesConfig & { children: React.ReactNode }) {
	// Merged with whatever is already in scope, rather than replacing it. The app installs
	// `highlightJson` / `renderValue` once at the root; a surface that can also filter by a value
	// then nests a provider supplying only that, without having to re-thread the root's config.
	const parent = React.use(AttributesConfigContext)
	const value = React.useMemo<AttributesConfig>(
		() => ({
			highlightJson: highlightJson ?? parent.highlightJson,
			renderValue: renderValue ?? parent.renderValue,
			onFilterByAttribute: onFilterByAttribute ?? parent.onFilterByAttribute,
			canFilterAttribute: canFilterAttribute ?? parent.canFilterAttribute,
		}),
		[highlightJson, renderValue, onFilterByAttribute, canFilterAttribute, parent],
	)
	return <AttributesConfigContext value={value}>{children}</AttributesConfigContext>
}

export function useAttributesConfig(): AttributesConfig {
	return React.use(AttributesConfigContext)
}

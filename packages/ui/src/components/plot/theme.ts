"use client"

import { useMemo } from "react"

import { useTheme } from "../../hooks/use-theme"

/**
 * A design token (`--chart-p99`) or a literal colour. Tokens are resolved to
 * literals before they reach a chart definition.
 */
export type PlotColorToken = `--${string}` | (string & {})

/**
 * Resolve one token against the live document.
 *
 * Canvas cannot resolve `var(--chart-p99)` — the 2D context takes literal colour
 * strings — so every token has to be read off the computed style first. SVG
 * would accept the `var()` directly, but both renderers share one definition, so
 * both take the resolved literal.
 */
export function resolvePlotColor(token: PlotColorToken, fallback: string): string {
	if (typeof document === "undefined") return fallback
	// `resolveSeriesColors` hands back WRAPPED tokens — `var(--chart-p95)`,
	// `var(--severity-error)` — for every semantically named series, and a bare
	// `--token` only for the hashed identity palette. Accepting just the bare form
	// let the wrapped ones through untouched, straight into the definition, where
	// `assertResolvedColors` threw during render in DEV. It fired on the most
	// ordinary chart there is: an ungrouped series is named `value`/`count`/`all`,
	// which is exactly the semantic set.
	// Unwrap `var(--token)` only when it names ONE custom property. A `var()`
	// carrying its own fallback (`var(--x, #abc)`) must reach the renderer intact:
	// unwrapping it would look up a property literally named `--x, #abc`, miss, and
	// silently swap the author's fallback for ours.
	const inner = token.startsWith("var(") && token.endsWith(")") ? token.slice(4, -1).trim() : token
	const name = inner.includes(",") ? token : inner
	if (!name.startsWith("--")) return token
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
	return value === "" ? fallback : value
}

/**
 * Resolve a token map to literal colours, re-resolving whenever the theme flips.
 *
 * The `useTheme` dependency is the whole point. Reading computed styles once at
 * mount — which is what the original pilot did — leaves every canvas chart
 * painted in the previous palette after a light/dark toggle, because canvas
 * holds literals and nothing re-renders it. `useTheme` is a
 * `useSyncExternalStore` over the `light`/`dark` class on `<html>`, so a flip
 * invalidates this memo and the scene repaints with the new palette.
 *
 * Pass a stable `tokens` object (module scope, or `useMemo`'d) — a fresh object
 * literal each render defeats the memo and re-reads computed style per frame.
 */
export function usePlotColors<TKey extends string>(
	tokens: Readonly<Record<TKey, readonly [token: PlotColorToken, fallback: string]>>,
): Readonly<Record<TKey, string>> {
	const { theme } = useTheme()

	return useMemo(
		() => {
			const resolved = {} as Record<TKey, string>
			for (const key of Object.keys(tokens) as TKey[]) {
				const [token, fallback] = tokens[key]
				resolved[key] = resolvePlotColor(token, fallback)
			}
			return resolved
		},
		// `theme` is an INVALIDATION KEY, not a read — the body reads computed
		// style, which the theme class silently changes underneath it. oxlint sees
		// an unused dependency; removing it is the bug this hook exists to fix.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[tokens, theme],
	)
}

/**
 * Chrome colours every chart needs, resolved once per theme.
 *
 * Module scope, not an inline literal: `usePlotColors` memoizes on this object's
 * identity, so a fresh literal per render would re-read computed style on every
 * frame.
 */
export const PLOT_CHROME_TOKENS = {
	border: ["--border", "#3f3f46"],
	background: ["--background", "#0c0a09"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

export type PlotChromeColors = Readonly<Record<keyof typeof PLOT_CHROME_TOKENS, string>>

/** The chrome colours, re-resolved whenever the theme flips. */
export function usePlotChromeColors(): PlotChromeColors {
	return usePlotColors(PLOT_CHROME_TOKENS)
}

/**
 * Resolve a DYNAMIC set of colour tokens — one per series, where the series are
 * whatever the query happened to return.
 *
 * `usePlotColors` takes a fixed, module-scope token map, which is right for a
 * chart whose series are known at build time (p50/p95/p99). A query-builder
 * chart's series are not: `resolveSeriesColors` assigns `var(--chart-3)` and
 * friends per result set, and every one of those has to be resolved to a literal
 * before it reaches a definition, because the canvas 2D context cannot read
 * `var()`.
 *
 * `tokensByKey` must be memoized by the caller — this re-resolves whenever its
 * identity changes, and re-reading computed style per frame is the cost
 * `usePlotColors` exists to avoid.
 */
export function useResolvedSeriesColors(
	tokensByKey: ReadonlyMap<string, string>,
	fallback: string,
): ReadonlyMap<string, string> {
	const { theme } = useTheme()

	return useMemo(
		() => {
			const resolved = new Map<string, string>()
			for (const [key, token] of tokensByKey) {
				resolved.set(key, resolvePlotColor(token, fallback))
			}
			return resolved
		},
		// `theme` is an INVALIDATION KEY — see `usePlotColors`.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[tokensByKey, fallback, theme],
	)
}

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
	if (!token.startsWith("--")) return token
	const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
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

<!-- The Tailwind entry every rendered document needs: the Maple palette plus
     the utilities layer. Preflight is deliberately NOT imported — it would
     stamp box-sizing/margin/padding onto every element, which no email client
     needs and which react-email never emitted. The cost is that `border-*`
     utilities carry no border-style, so every border also names `border-solid`
     (or sets `border-bottom` inline). -->
<template>
	<style>
		@import "tailwindcss/theme.css" layer(theme);
		@import "tailwindcss/utilities.css" layer(utilities);
		@theme {
			--color-maple-bg: #141210;
			--color-maple-surface: #1e1b18;
			--color-maple-card: #262320;
			--color-maple-elevated: #2e2a26;
			--color-maple-border: #3a342e;
			--color-maple-border-subtle: #302b26;
			--color-maple-fg: #e8dfd3;
			--color-maple-fg-muted: #8a7f72;
			--color-maple-fg-dim: #5c554c;
			--color-maple-orange: #e8872a;
			--color-maple-orange-light: #f0a050;
			--color-maple-orange-dim: #a05e1c;
			--color-maple-green: #4aa865;
			--color-maple-green-dim: #2d6b3d;
			--color-maple-red: #e85d4a;
			--color-maple-red-dim: #8b3530;
			--color-maple-blue: #4a9eff;
			--color-maple-amber: #e8a02a;
			--font-mono: "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

			/*
			 * Tailwind ships these three as ratios (20/14, 16/12, 24/16). Anything
			 * that compiles the ratio to fewer digits than the exact fraction —
			 * lightningcss truncates 1.4285714285714286 to 1.42857 — computes
			 * 19.99998px instead of 20px, and Chrome rounds that line box down: the
			 * text sits one pixel high inside an otherwise identical box. Pinning
			 * the px values keeps the arithmetic exact. Every other size in the
			 * templates is an arbitrary `text-[Npx]` paired with an explicit
			 * `leading-*`, whose ratios (1, 1.25, 1.375) are exact already.
			 */
			--text-xs--line-height: 16px;
			--text-sm--line-height: 20px;
			--text-base--line-height: 24px;
		}
	</style>
</template>

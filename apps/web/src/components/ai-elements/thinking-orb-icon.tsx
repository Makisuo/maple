import { ThinkingOrb, type OrbState } from "@maple/thinking-orbs"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { cn } from "@maple/ui/lib/utils"

interface ThinkingOrbIconProps {
	state: OrbState
	/**
	 * What the orb is drawn on top of. `page` follows the active theme; `primary` pins dark ink
	 * because `--primary` is the copper accent in *both* themes (L≈0.66/0.71 against an L≈0.21
	 * foreground), so an orb that followed the page theme would paint light ink onto a light
	 * button and vanish in dark mode.
	 */
	surface?: "page" | "primary"
	className?: string
}

/**
 * The chat's "working" glyph — a vendored `ThinkingOrb` wired to Maple's theme store.
 *
 * Two things are deliberate here.
 *
 * `theme` is passed explicitly rather than left on the library's `"auto"` default. Auto
 * resolution installs a `MutationObserver` on `<html>` with `subtree: true` watching `class`,
 * which in an app this busy fires on unrelated class churn (Base UI popups, hover states) and
 * calls `setState` on every hit — a React update on the streaming hot path, which is exactly
 * what `StatusMarker` has always avoided. With an explicit `"dark"`/`"light"` the library's
 * effect early-returns and never constructs the observer. `useTheme` is a `useSyncExternalStore`
 * over a module global, so one call per orb is cheap and re-renders only on a real theme flip.
 *
 * The size is pinned to 20. `OrbSize` is the literal union `64 | 20` — the two presets carry
 * their own dot counts, dot sizes and speeds, so they are separate designs rather than a scale
 * factor. 20 is the inline-text preset; don't CSS-scale the 64 one down to fit a smaller slot.
 *
 * `prefers-reduced-motion` is handled inside the library: it paints one static representative
 * frame and never starts a loop.
 */
export function ThinkingOrbIcon({ state, surface = "page", className }: ThinkingOrbIconProps) {
	const { theme } = useTheme()
	// The library names these after the substrate, not the ink: `light` means "drawn for a light
	// background", i.e. dark dots.
	const orbTheme = surface === "primary" ? "light" : theme
	return <ThinkingOrb state={state} size={20} theme={orbTheme} className={cn("shrink-0", className)} />
}

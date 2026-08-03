"use client"

import * as React from "react"

import { useCopy, type CopyStatus, type UseCopyOptions } from "../../hooks/use-copy"
import { cn } from "../../lib/utils"
import { CopyIcon, type IconComponent } from "../icons"
import { Button, type ButtonProps } from "./button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip"

/**
 * The house icon set is dotted-outline, so only the check is drawable — it's the
 * one glyph in the set (see `circle-check.tsx`) built from a single continuous
 * path. Sized to span the same 4–20 box the dotted icons do, so it doesn't read
 * as smaller than the copy glyph it replaces.
 */
const CHECK_PATH = "M4.5 12.5L9.5 17.5L19.5 6.5"

/**
 * `Button` dims unstyled child SVGs to 80% (its `[&_svg:not([class*='opacity-'])]`
 * rule). That's right for the resting glyph and wrong for the success/failure
 * ones — those carry semantic color and should land at full strength. Any class
 * matching `opacity-` opts out.
 */
const FULL_STRENGTH = "opacity-100"

/**
 * All three glyph layers stay mounted and the active one is picked purely in
 * CSS, off a `data-copy-status` attribute on the nearest `group/copy`. This is a
 * per-row affordance on detail surfaces — one per expanded JSON blob, per log
 * attribute chip, per key row — and it sits idle essentially all the time, so it
 * deliberately costs nothing per instance: no animation library, no
 * `prefers-reduced-motion` subscription, no work at all until the status flips.
 *
 * The timings are what the springs used to land on. The old crossfade spring was
 * overdamped (ζ≈1.18), which reads as a decel curve, so it maps onto a 240ms
 * ease-out; the draw keeps its original 260ms.
 */
const EASE = "ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"

/** One grid cell, faded and scaled back until its status is the active one. */
const LAYER = cn(
	"col-start-1 row-start-1 flex items-center justify-center",
	"scale-[0.92] opacity-0 transition-[opacity,scale] duration-[240ms]",
	EASE,
)

/**
 * Spelled out per status rather than interpolated — Tailwind only emits classes
 * that appear literally in the source.
 */
const LAYER_ACTIVE: Record<CopyStatus, string> = {
	copied: "group-data-[copy-status=copied]/copy:scale-100 group-data-[copy-status=copied]/copy:opacity-100",
	error: "group-data-[copy-status=error]/copy:scale-100 group-data-[copy-status=error]/copy:opacity-100",
	idle: "group-data-[copy-status=idle]/copy:scale-100 group-data-[copy-status=idle]/copy:opacity-100",
}

/**
 * `pathLength="1"` renormalises the check to a unit length, so the dash pair is
 * a literal `1` rather than a measured one and the draw is a plain
 * `stroke-dashoffset: 1 → 0` — no JS ever touches the path.
 */
const CHECK_DRAW = cn(
	"[stroke-dasharray:1] [stroke-dashoffset:1] transition-[stroke-dashoffset] duration-[260ms]",
	"group-data-[copy-status=copied]/copy:[stroke-dashoffset:0]",
	EASE,
)

/** Same crossfade as the glyph, plus the blur/rise the label has always had. */
const LABEL_LAYER = cn(
	"col-start-1 row-start-1 whitespace-nowrap",
	"translate-y-[3px] opacity-0 blur-[3px] transition-[opacity,filter,translate] duration-[240ms]",
	EASE,
)

const LABEL_ACTIVE: Record<CopyStatus, string> = {
	copied: "group-data-[copy-status=copied]/copy:translate-y-0 group-data-[copy-status=copied]/copy:opacity-100 group-data-[copy-status=copied]/copy:blur-[0px]",
	error: "group-data-[copy-status=error]/copy:translate-y-0 group-data-[copy-status=error]/copy:opacity-100 group-data-[copy-status=error]/copy:blur-[0px]",
	idle: "group-data-[copy-status=idle]/copy:translate-y-0 group-data-[copy-status=idle]/copy:opacity-100 group-data-[copy-status=idle]/copy:blur-[0px]",
}

export interface CopyTooltipLabels {
	copiedLabel?: string
	errorLabel?: string
}

/**
 * The wording every copy tooltip shares. Lives here rather than inline in each
 * component so `CopyButton` and `CopyableBadge` can't drift on it.
 */
export function copyTooltipText(
	status: CopyStatus,
	label: string,
	{ copiedLabel = "Copied", errorLabel = "Failed to copy" }: CopyTooltipLabels = {},
): string {
	if (status === "copied") return copiedLabel
	if (status === "error") return errorLabel
	return `Copy ${label}`
}

export interface CopyIndicatorProps {
	status: CopyStatus
	/** Rendered size in px. Matches the `size` prop on the icon components. */
	size?: number
	/** Icon for the resting state — pass `LinkIcon` for share-a-URL affordances,
	 * or whatever else the callsite is copying. Only the idle glyph is the
	 * callsite's to pick; the success check and failure X are fixed. */
	idleIcon?: IconComponent
	className?: string
}

/**
 * The three-state copy glyph: resting icon, a check that *draws* itself on
 * success, and an X on failure. All three occupy one grid cell so swapping
 * states never reflows the row.
 *
 * Exported on its own for surfaces that can't use `CopyButton` — dropdown menu
 * items, chips, and anything already wrapped in its own trigger. Standalone it
 * carries its own `group/copy`, so it animates whether or not a `CopyButton` is
 * above it.
 */
export function CopyIndicator({
	status,
	size = 14,
	idleIcon: Idle = CopyIcon,
	className,
}: CopyIndicatorProps): React.ReactElement {
	return (
		<span
			aria-hidden="true"
			data-copy-status={status}
			className={cn("group/copy grid shrink-0", className)}
			style={{ height: size, width: size }}
		>
			<span className={cn(LAYER, LAYER_ACTIVE.idle)}>
				<Idle size={size} />
			</span>

			<span className={cn(LAYER, LAYER_ACTIVE.copied, "text-severity-info")}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					width={size}
					height={size}
					fill="none"
					aria-hidden="true"
					className={FULL_STRENGTH}
				>
					<path
						d={CHECK_PATH}
						pathLength={1}
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
						className={CHECK_DRAW}
					/>
				</svg>
			</span>

			<span className={cn(LAYER, LAYER_ACTIVE.error, "text-destructive-foreground")}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					width={size}
					height={size}
					fill="none"
					aria-hidden="true"
					className={FULL_STRENGTH}
				>
					<path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
					<path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
				</svg>
			</span>
		</span>
	)
}

/**
 * Label that crossfades between the three states. Every string is stacked in
 * the same grid cell, so the button is sized to the longest one up front and
 * never jumps width mid-animation. Reads the status off the `group/copy` its
 * `CopyButton` puts on the button element.
 */
function CopyLabel({ labels }: { labels: ReadonlyArray<readonly [CopyStatus, string]> }): React.ReactElement {
	return (
		<span aria-hidden="true" className="relative grid">
			{labels.map(([key, text]) => (
				<span key={key} className={cn(LABEL_LAYER, LABEL_ACTIVE[key])}>
					{text}
				</span>
			))}
		</span>
	)
}

export interface CopyButtonProps
	extends
		Omit<ButtonProps, "children" | "onCopy" | "onError" | "value">,
		Pick<UseCopyOptions, "timeout" | "toast" | "successMessage" | "onCopy" | "onError"> {
	/** What lands on the clipboard. Pass a thunk when building it is expensive. */
	value: string | (() => string)
	/** Human name for the thing being copied — drives `aria-label` and toasts. */
	label: string
	/** Text shown next to the glyph while resting. Passing it is what turns the
	 * animated text label on; glyph-only is the default. */
	idleLabel?: string
	copiedLabel?: string
	errorLabel?: string
	/** Wrap in a tooltip whose text follows the copy status. */
	tooltip?: boolean
	/** Sonner feedback; on by default. See `useCopy`. */
	toast?: boolean
	/** Glyph size in px. Defaults to 14 to match the icon buttons it replaces. */
	iconSize?: number
	/** Resting glyph. Defaults to the copy icon; pass `LinkIcon` (or any icon)
	 * when the thing being copied reads as something else. */
	idleIcon?: IconComponent
}

/** Resolve a lazy `value` without letting a throwing resolver (a circular
 * `JSON.stringify`, say) escape as an uncaught click handler error. */
function resolveValue(value: string | (() => string)): string | null {
	if (typeof value !== "function") return value
	try {
		return value()
	} catch {
		return null
	}
}

/**
 * The one copy affordance. Built on `Button`, so every variant, size, pressed
 * state, focus ring, and the `render` polymorphism come along unchanged —
 * motion is scoped to the glyph. Toasts by default; the drawn check is the
 * immediate, in-place confirmation on top of that. Pass `toast={false}` only
 * where a toast per click would pile up.
 */
export function CopyButton({
	value,
	label,
	idleLabel,
	copiedLabel = "Copied",
	errorLabel = "Failed to copy",
	tooltip,
	iconSize = 14,
	idleIcon,
	timeout,
	toast,
	successMessage,
	onCopy,
	onError,
	variant = "ghost",
	size,
	className,
	onClick,
	...props
}: CopyButtonProps): React.ReactElement {
	const { copy, status } = useCopy({ label, onCopy, onError, successMessage, timeout, toast })
	const withLabel = idleLabel !== undefined
	const resolvedSize = size ?? (withLabel ? "sm" : "icon-xs")

	const button = (
		<Button
			aria-label={`Copy ${label}`}
			variant={variant}
			size={resolvedSize}
			data-copy-status={status}
			className={cn("group/copy text-muted-foreground hover:text-foreground", className)}
			onClick={(event) => {
				onClick?.(event)
				if (event.defaultPrevented) return
				void copy(resolveValue(value))
			}}
			{...props}
		>
			<CopyIndicator status={status} size={iconSize} idleIcon={idleIcon} />
			{withLabel && (
				<CopyLabel
					labels={[
						["idle", idleLabel],
						["copied", copiedLabel],
						["error", errorLabel],
					]}
				/>
			)}
			<span role="status" aria-live="polite" className="sr-only">
				{status === "copied" ? copiedLabel : status === "error" ? errorLabel : ""}
			</span>
		</Button>
	)

	if (!tooltip) return button

	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipPopup>{copyTooltipText(status, label, { copiedLabel, errorLabel })}</TooltipPopup>
		</Tooltip>
	)
}

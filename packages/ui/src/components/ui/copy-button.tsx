"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { useCopy, type CopyStatus, type UseCopyOptions } from "../../hooks/use-copy"
import { cn } from "../../lib/utils"
import { CopyIcon, LinkIcon } from "../icons"
import { Button, type ButtonProps } from "./button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip"

const EASE = [0.23, 1, 0.32, 1] as const
const CROSSFADE = { damping: 34, mass: 0.8, stiffness: 260, type: "spring" } as const
const DRAW = { duration: 0.26, ease: EASE } as const
const INSTANT = { duration: 0 } as const

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

export type CopyGlyph = "copy" | "link"

export interface CopyIndicatorProps {
	status: CopyStatus
	/** Rendered size in px. Matches the `size` prop on the icon components. */
	size?: number
	/** Which icon represents the resting state — `link` for share-a-URL affordances. */
	glyph?: CopyGlyph
	className?: string
}

/**
 * The three-state copy glyph: resting icon, a check that *draws* itself on
 * success, and an X on failure. All three occupy one grid cell so swapping
 * states never reflows the row.
 *
 * Exported on its own for surfaces that can't use `CopyButton` — dropdown menu
 * items, chips, and anything already wrapped in its own trigger.
 */
export function CopyIndicator({
	status,
	size = 14,
	glyph = "copy",
	className,
}: CopyIndicatorProps): React.ReactElement {
	const reduced = useReducedMotion()
	const fade = reduced ? INSTANT : CROSSFADE
	const draw = reduced ? INSTANT : DRAW

	const Idle = glyph === "link" ? LinkIcon : CopyIcon
	const layer = "col-start-1 row-start-1 flex items-center justify-center"

	return (
		<span
			aria-hidden="true"
			className={cn("grid shrink-0", className)}
			style={{ height: size, width: size }}
		>
			<motion.span
				className={layer}
				initial={false}
				animate={{ opacity: status === "idle" ? 1 : 0, scale: status === "idle" ? 1 : 0.92 }}
				transition={fade}
			>
				<Idle size={size} />
			</motion.span>

			<motion.span
				className={cn(layer, "text-severity-info")}
				initial={false}
				animate={{ opacity: status === "copied" ? 1 : 0, scale: status === "copied" ? 1 : 0.92 }}
				transition={fade}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					width={size}
					height={size}
					fill="none"
					aria-hidden="true"
					className={FULL_STRENGTH}
				>
					<motion.path
						d={CHECK_PATH}
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
						initial={false}
						animate={{ pathLength: status === "copied" ? 1 : 0 }}
						transition={draw}
					/>
				</svg>
			</motion.span>

			<motion.span
				className={cn(layer, "text-destructive-foreground")}
				initial={false}
				animate={{ opacity: status === "error" ? 1 : 0, scale: status === "error" ? 1 : 0.92 }}
				transition={fade}
			>
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
			</motion.span>
		</span>
	)
}

/**
 * Label that crossfades between the three states. Every string is stacked in
 * the same grid cell, so the button is sized to the longest one up front and
 * never jumps width mid-animation.
 */
function CopyLabel({
	status,
	labels,
}: {
	status: CopyStatus
	labels: ReadonlyArray<readonly [CopyStatus, string]>
}): React.ReactElement {
	const reduced = useReducedMotion()
	const fade = reduced ? INSTANT : CROSSFADE

	return (
		<span aria-hidden="true" className="relative grid">
			{labels.map(([key, text]) => (
				<motion.span
					key={key}
					initial={false}
					animate={
						key === status
							? { filter: "blur(0px)", opacity: 1, y: 0 }
							: { filter: "blur(3px)", opacity: 0, y: 3 }
					}
					transition={fade}
					className="col-start-1 row-start-1 whitespace-nowrap"
				>
					{text}
				</motion.span>
			))}
		</span>
	)
}

export interface CopyButtonProps
	extends Omit<ButtonProps, "children" | "onCopy" | "onError" | "value">,
		Pick<UseCopyOptions, "timeout" | "toast" | "successMessage" | "onCopy" | "onError"> {
	/** What lands on the clipboard. Pass a thunk when building it is expensive. */
	value: string | (() => string)
	/** Human name for the thing being copied — drives `aria-label` and toasts. */
	label: string
	/** Text shown next to the glyph while resting. Implies `showLabel`. */
	idleLabel?: string
	copiedLabel?: string
	errorLabel?: string
	/** Render the animated text label beside the glyph. */
	showLabel?: boolean
	/** Wrap in a tooltip whose text follows the copy status. */
	tooltip?: boolean
	/** Sonner feedback; on by default. See `useCopy`. */
	toast?: boolean
	/** Glyph size in px. Defaults to 14 to match the icon buttons it replaces. */
	iconSize?: number
	glyph?: CopyGlyph
}

/**
 * The one copy affordance. Built on `Button`, so every variant, size, pressed
 * state, focus ring, and the `render` polymorphism come along unchanged —
 * motion is scoped to the glyph. Toasts by default; the drawn check is the
 * immediate, in-place confirmation on top of that. Pass `toast={false}` only
 * where a toast per click would pile up.
 */
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

export function CopyButton({
	value,
	label,
	idleLabel,
	copiedLabel = "Copied",
	errorLabel = "Failed to copy",
	showLabel,
	tooltip,
	iconSize = 14,
	glyph = "copy",
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
	const withLabel = showLabel ?? idleLabel !== undefined
	const resolvedSize = size ?? (withLabel ? "sm" : "icon-xs")

	const button = (
		<Button
			aria-label={`Copy ${label}`}
			variant={variant}
			size={resolvedSize}
			className={cn("text-muted-foreground hover:text-foreground", className)}
			onClick={(event) => {
				onClick?.(event)
				if (event.defaultPrevented) return
				void copy(resolveValue(value))
			}}
			{...props}
		>
			<CopyIndicator status={status} size={iconSize} glyph={glyph} />
			{withLabel && (
				<CopyLabel
					status={status}
					labels={[
						["idle", idleLabel ?? label],
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
			<TooltipPopup>
				{status === "copied" ? copiedLabel : status === "error" ? errorLabel : `Copy ${label}`}
			</TooltipPopup>
		</Tooltip>
	)
}

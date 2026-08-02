"use client"

import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import type { VariantProps } from "class-variance-authority"
import * as React from "react"
import { cn } from "../../lib/utils"
import { Toggle as ToggleComponent, type toggleVariants } from "./toggle"

export const ToggleGroupContext: React.Context<
	VariantProps<typeof toggleVariants> & { connected?: boolean }
> = React.createContext<VariantProps<typeof toggleVariants> & { connected?: boolean }>({
	connected: true,
	size: "default",
	variant: "default",
})

/**
 * The recessed track a connected group draws around its segments.
 *
 * `bg-black/…` rather than a surface token on purpose: a segmented control sits
 * on cards, toolbars, and dialogs of different shades, and a fixed surface color
 * reads as raised on the darker ones. Darkening whatever is behind it keeps the
 * track recessed everywhere.
 */
const trackClass =
	"w-fit items-center gap-0.5 rounded-lg border border-input bg-black/[0.04] p-0.5 dark:bg-black/25"

export function ToggleGroup({
	className,
	variant = "default",
	size = "default",
	orientation = "horizontal",
	connected = true,
	children,
	...props
}: ToggleGroupPrimitive.Props &
	VariantProps<typeof toggleVariants> & {
		/**
		 * When `true` (default), `outline` items fuse into a single segmented
		 * bar (shared borders, only the outer corners rounded). Set to `false`
		 * to render each item as a standalone chip — full border, fully
		 * rounded, spaced apart and free to wrap.
		 */
		connected?: boolean
	}): React.ReactElement {
	// A connected group is a segmented control: one recessed track, one raised
	// pill. It used to be faked by fusing each item's own border into a shared
	// bar (collapsed corners, negative offsets, hairline seams between items) —
	// which read as a row of buttons welded together rather than one control, and
	// left every seam to hand-tune. The track replaces all of it.
	const segmented = connected && variant !== "default"

	return (
		<ToggleGroupPrimitive
			className={cn(
				"flex *:focus-visible:z-10",
				orientation === "horizontal"
					? "*:pointer-coarse:after:min-w-auto"
					: "*:pointer-coarse:after:min-h-auto",
				orientation === "vertical" && "flex-col",
				segmented ? trackClass : connected ? "w-fit gap-0.5" : "flex-wrap gap-2",
				className,
			)}
			data-size={size}
			data-slot="toggle-group"
			data-variant={variant}
			orientation={orientation}
			{...props}
		>
			<ToggleGroupContext.Provider value={{ connected, size, variant }}>
				{children}
			</ToggleGroupContext.Provider>
		</ToggleGroupPrimitive>
	)
}

export function ToggleGroupItem({
	className,
	children,
	variant,
	size,
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>): React.ReactElement {
	const context = React.useContext(ToggleGroupContext)

	const groupVariant = context.variant || variant
	const resolvedSize = context.size || size
	// Inside a track, an `outline` item drops its own frame and becomes a segment.
	// Standalone `<Toggle variant="outline">` (a toolbar icon button) is untouched:
	// it has no track to sit in, so it still draws its own border.
	const resolvedVariant =
		context.connected !== false && groupVariant === "outline" ? "segment" : groupVariant

	return (
		<ToggleComponent
			className={className}
			data-size={resolvedSize}
			data-variant={resolvedVariant}
			size={resolvedSize}
			variant={resolvedVariant}
			{...props}
		>
			{children}
		</ToggleComponent>
	)
}

export { ToggleGroupPrimitive }

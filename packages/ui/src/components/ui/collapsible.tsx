"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import type React from "react"

export function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props): React.ReactElement {
	return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

export function CollapsibleTrigger({
	className,
	...props
}: CollapsiblePrimitive.Trigger.Props): React.ReactElement {
	return <CollapsiblePrimitive.Trigger className={className} data-slot="collapsible-trigger" {...props} />
}

// `className` is narrowed to a plain string: it styles the inner wrapper below, so Base UI's
// state-function form has no panel state to resolve against.
export function CollapsiblePanel({
	className,
	children,
	...props
}: Omit<CollapsiblePrimitive.Panel.Props, "className"> & {
	className?: string
}): React.ReactElement {
	return (
		<CollapsiblePrimitive.Panel
			// `contain: layout paint` keeps each frame of the height transition from re-laying out
			// the panel's descendants — the height is animated on the main thread, so this runs 12
			// times per collapse. Never add `size` here: Base UI reads `scrollHeight` off this
			// element to turn `auto` into the pixel value it animates from, and size containment
			// would report 0.
			className="h-(--collapsible-panel-height) overflow-hidden [contain:layout_paint] transition-[height] duration-200 ease-out motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0"
			data-slot="collapsible-panel"
			{...props}
		>
			{/* Consumer styles go on an inner element, never on the panel itself: padding skews the
			    measured height, and flex/alignment properties are exactly what Base UI has to strip
			    before it can measure (see `resetLayoutStyles`). Mirrors `AccordionPanel`. */}
			<div className={className}>{children}</div>
		</CollapsiblePrimitive.Panel>
	)
}

export { CollapsiblePrimitive, CollapsiblePanel as CollapsibleContent }

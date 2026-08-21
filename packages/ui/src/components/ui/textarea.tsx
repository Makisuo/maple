"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import { mergeProps } from "@base-ui/react/merge-props"
import type * as React from "react"
import { cn } from "../../lib/utils"

export type TextareaProps = React.ComponentPropsWithoutRef<"textarea"> &
	React.RefAttributes<HTMLTextAreaElement> & {
		size?: "sm" | "default" | "lg" | number
		unstyled?: boolean
		/**
		 * Classes for the inner `<textarea>` itself, merged last so they win over
		 * the control's own padding and min-height. Reach for this instead of a
		 * `[&_textarea]:` descendant selector on `className` — that only worked by
		 * accident of the DOM shape and silently broke on `!` specificity ties.
		 */
		controlClassName?: string
	}

/**
 * The layout the control needs in every mode. Deliberately *not* gated on
 * `unstyled`: `w-full` is what gives the field a definite width to lay out
 * against, and `field-sizing-content` on the inner textarea resolves against it.
 * Dropping it along with the chrome left an unstyled field shrink-to-fit, so an
 * empty one sized itself to a one-character-per-line placeholder and shot up to
 * its max height. Inside an `InputGroup` this span is `display: contents`, so
 * these classes are inert there either way.
 */
const CONTROL_LAYOUT = "relative inline-flex w-full"

/** Border, background, shadow and focus ring — the part `unstyled` removes. */
const CONTROL_CHROME =
	"rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export function Textarea({
	className,
	controlClassName,
	size = "default",
	unstyled = false,
	ref,
	...props
}: TextareaProps): React.ReactElement {
	return (
		<span
			className={cn(CONTROL_LAYOUT, !unstyled && CONTROL_CHROME, className)}
			data-size={size}
			data-slot="textarea-control"
		>
			<FieldPrimitive.Control
				ref={ref}
				value={props.value}
				defaultValue={props.defaultValue}
				disabled={props.disabled}
				id={props.id}
				name={props.name}
				render={(defaultProps: React.ComponentProps<"textarea">) => (
					<textarea
						className={cn(
							"field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
							size === "sm" &&
								"min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5",
							size === "lg" && "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
							controlClassName,
						)}
						data-slot="textarea"
						{...mergeProps(defaultProps, props)}
					/>
				)}
			/>
		</span>
	)
}

export { FieldPrimitive }

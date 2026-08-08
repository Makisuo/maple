"use client"

import type { ChatStatus } from "./types"
import type { ComponentProps, FormEvent, FormEventHandler, HTMLAttributes, KeyboardEventHandler } from "react"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/lib/utils"
import { CornerDownLeftIcon, SquareIcon, XmarkIcon } from "@/components/icons"
import { ThinkingOrbIcon } from "./thinking-orb-icon"
import { useCallback, useState } from "react"

/**
 * The chat composer, vendored from shadcn's `ai-elements` and cut down to what Maple's
 * chat actually uses. The upstream component carries attachment/drag-drop, model-select,
 * hover-card and command-palette machinery that this app has no path to: the chat has no
 * file uploads, and the model is picked server-side by the chat agent.
 *
 * There is no newer shadcn composer to move to — the current track's composer is built
 * around the Vercel `ai-sdk` helper, which this app deliberately does not use.
 */

export interface PromptInputMessage {
	text: string
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
	onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>
}

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
	const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
		(event) => {
			event.preventDefault()
			const form = event.currentTarget
			const text = (new FormData(form).get("message") as string) || ""
			// Reset before handing off: `onSubmit` may be async, and anything the user
			// types while it settles would otherwise be wiped by a later reset.
			form.reset()
			onSubmit({ text }, event)
		},
		[onSubmit],
	)

	return (
		<form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
			<InputGroup className="overflow-hidden">{children}</InputGroup>
		</form>
	)
}

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>

export const PromptInputTextarea = ({
	onKeyDown,
	className,
	placeholder = "What would you like to know?",
	...props
}: PromptInputTextareaProps) => {
	const [isComposing, setIsComposing] = useState(false)

	const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
		(e) => {
			onKeyDown?.(e)
			if (e.defaultPrevented) return
			if (e.key !== "Enter") return
			// An IME candidate window swallows Enter to commit the composition; submitting
			// here would send a half-typed word.
			if (isComposing || e.nativeEvent.isComposing) return
			if (e.shiftKey) return

			e.preventDefault()
			const { form } = e.currentTarget
			const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null
			if (submitButton?.disabled) return
			form?.requestSubmit()
		},
		[onKeyDown, isComposing],
	)

	const handleCompositionEnd = useCallback(() => setIsComposing(false), [])
	const handleCompositionStart = useCallback(() => setIsComposing(true), [])

	return (
		<InputGroupTextarea
			className={cn("field-sizing-content max-h-48 min-h-16", className)}
			name="message"
			onCompositionEnd={handleCompositionEnd}
			onCompositionStart={handleCompositionStart}
			onKeyDown={handleKeyDown}
			placeholder={placeholder}
			{...props}
		/>
	)
}

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
	<InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />
)

/**
 * One cell of the submit button's orb↔stop crossfade. Same shape as `CopyButton`'s layer stack:
 * both glyphs occupy the single grid cell so the button never reflows, and the swap is scale +
 * opacity rather than a swap of mounted nodes.
 */
const STOP_LAYER = cn(
	"col-start-1 row-start-1 transition-[opacity,scale] duration-[160ms]",
	"ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
)

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
	status?: ChatStatus
	/** Cancels the running turn. Turns the button into a stop control while generating. */
	onStop?: () => void
}

/**
 * Send button, which becomes a stop button while a turn is running. An
 * investigation pass can spend a minute across a dozen tool calls, so being able
 * to call it off is the difference between a chat you can steer and one you wait
 * out. Without `onStop` the orb is inert — the caller has nothing to cancel.
 */
export const PromptInputSubmit = ({
	className,
	variant = "default",
	size = "icon-sm",
	status,
	onStop,
	children,
	...props
}: PromptInputSubmitProps) => {
	const isGenerating = status === "submitted" || status === "streaming"
	const canStop = isGenerating && onStop !== undefined

	let Icon = <CornerDownLeftIcon className="size-4" />
	if (canStop) {
		// The orb is the resting state and the stop square is revealed on hover/focus, so the
		// button reads as "a turn is running" at a glance without giving up the affordance that
		// makes it worth having. Both layers are always mounted and cross-faded with CSS — no
		// state, no remount, and nothing that re-enters React while the turn streams.
		Icon = (
			<span className="grid place-items-center">
				<ThinkingOrbIcon
					state="working"
					surface="primary"
					className={cn(
						STOP_LAYER,
						"group-hover/submit:scale-[0.92] group-hover/submit:opacity-0",
						"group-focus-visible/submit:scale-[0.92] group-focus-visible/submit:opacity-0",
					)}
				/>
				<SquareIcon
					className={cn(
						STOP_LAYER,
						"size-3.5 scale-[0.92] opacity-0",
						"group-hover/submit:scale-100 group-hover/submit:opacity-100",
						"group-focus-visible/submit:scale-100 group-focus-visible/submit:opacity-100",
					)}
				/>
			</span>
		)
	} else if (isGenerating) {
		// Nothing to cancel — the orb just reports that the turn is in flight.
		Icon = <ThinkingOrbIcon state="working" surface="primary" />
	} else if (status === "error") {
		Icon = <XmarkIcon className="size-4" />
	}

	return (
		<InputGroupButton
			aria-label={canStop ? "Stop generating" : isGenerating ? "Sending" : "Submit"}
			className={cn("group/submit", className)}
			size={size}
			type={canStop ? "button" : "submit"}
			variant={variant}
			onClick={canStop ? onStop : undefined}
			{...props}
		>
			{children ?? Icon}
		</InputGroupButton>
	)
}

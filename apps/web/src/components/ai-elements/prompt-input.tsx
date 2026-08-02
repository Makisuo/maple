"use client"

import type { ChatStatus } from "./types"
import type { ComponentProps, FormEvent, FormEventHandler, HTMLAttributes, KeyboardEventHandler } from "react"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@maple/ui/components/ui/input-group"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@/lib/utils"
import { CornerDownLeftIcon, SquareIcon, XmarkIcon } from "@/components/icons"
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

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
	status?: ChatStatus
	/** Cancels the running turn. Turns the button into a stop control while generating. */
	onStop?: () => void
}

/**
 * Send button, which becomes a stop button while a turn is running. An
 * investigation pass can spend a minute across a dozen tool calls, so being able
 * to call it off is the difference between a chat you can steer and one you wait
 * out. Without `onStop` it stays a spinner — the caller has nothing to cancel.
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
		Icon = <SquareIcon className="size-3.5" />
	} else if (isGenerating) {
		Icon = <Spinner />
	} else if (status === "error") {
		Icon = <XmarkIcon className="size-4" />
	}

	return (
		<InputGroupButton
			aria-label={canStop ? "Stop generating" : isGenerating ? "Sending" : "Submit"}
			className={cn(className)}
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

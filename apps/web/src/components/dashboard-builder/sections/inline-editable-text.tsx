import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@maple/ui/lib/utils"

interface InlineEditableTextProps {
	value: string
	onChange: (value: string) => void
	readOnly?: boolean
	className?: string
	inputClassName?: string
	ariaLabel: string
	/** Start in edit mode — used when a group or tab is created and wants naming. */
	autoEdit?: boolean
}

/**
 * Small inline renamer for section and tab titles.
 *
 * Deliberately separate from `InlineEditableTitle`, which hardcodes the page
 * heading's `text-2xl font-bold` and renders an `<h1>`. Generalising that one to
 * serve both would have put the dashboard's page title one prop away from
 * rendering at section size.
 *
 * Commits on Enter and on blur; Escape reverts. An empty or whitespace-only
 * value is discarded rather than saved — an untitled group is unclickable.
 */
export function InlineEditableText({
	value,
	onChange,
	readOnly = false,
	className,
	inputClassName,
	ariaLabel,
	autoEdit = false,
}: InlineEditableTextProps) {
	const [isEditing, setIsEditing] = useState(autoEdit && !readOnly)
	const [draft, setDraft] = useState(value)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (isEditing) inputRef.current?.select()
	}, [isEditing])

	const startEditing = useCallback(() => {
		if (readOnly) return
		setDraft(value)
		setIsEditing(true)
	}, [readOnly, value])

	const commit = () => {
		const trimmed = draft.trim()
		if (trimmed && trimmed !== value) onChange(trimmed)
		setIsEditing(false)
	}

	if (isEditing && !readOnly) {
		return (
			<input
				ref={inputRef}
				value={draft}
				aria-label={ariaLabel}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape") {
						event.preventDefault()
						setDraft(value)
						setIsEditing(false)
					}
					// The grid and the tab bar both listen for these; while typing a
					// title they belong to the input.
					event.stopPropagation()
				}}
				// Stops a double-click-to-rename from also reaching the tab button.
				onClick={(event) => event.stopPropagation()}
				className={cn(
					"min-w-0 border-b border-foreground/20 bg-transparent outline-none focus:border-foreground/50",
					className,
					inputClassName,
				)}
			/>
		)
	}

	return (
		<span
			onDoubleClick={startEditing}
			className={cn(className, !readOnly && "cursor-text")}
			title={readOnly ? undefined : "Double-click to rename"}
		>
			{value}
		</span>
	)
}

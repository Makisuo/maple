import * as React from "react"

import { Textarea } from "@maple/ui/components/ui/textarea"
import type {
	WhereClauseAutocompleteScope,
	WhereClauseAutocompleteValues,
} from "@/lib/query-builder/where-clause-autocomplete"
import type { QueryBuilderDataSource } from "@/lib/query-builder/model"
import { useAutocompleteContextOptional } from "@/hooks/use-autocomplete-context"
import { useAutocompleteValuesContextOptional } from "@/hooks/use-autocomplete-values"
import { useWhereClauseAutocomplete } from "@/hooks/use-where-clause-autocomplete"
import { cn } from "@maple/ui/utils"

interface WhereClauseEditorProps {
	dataSource: QueryBuilderDataSource
	value: string
	onChange: (value: string) => void
	values?: WhereClauseAutocompleteValues
	autocompleteScope?: WhereClauseAutocompleteScope
	onActiveAttributeKey?: (key: string | null) => void
	onActiveResourceAttributeKey?: (key: string | null) => void
	placeholder?: string
	rows?: number
	maxSuggestions?: number
	className?: string
	textareaClassName?: string
	ariaLabel?: string
}

export function WhereClauseEditor({
	dataSource,
	value,
	onChange,
	values,
	autocompleteScope,
	onActiveAttributeKey,
	onActiveResourceAttributeKey,
	placeholder,
	rows = 2,
	maxSuggestions,
	className,
	textareaClassName,
	ariaLabel,
}: WhereClauseEditorProps) {
	const textAreaRef = React.useRef<HTMLTextAreaElement | null>(null)

	// Use context directly when available and no explicit props provided
	const autocompleteCtx = useAutocompleteContextOptional()
	const autocompleteValuesCtx = useAutocompleteValuesContextOptional()
	const resolvedValues = values ?? autocompleteValuesCtx?.[dataSource]
	const resolvedOnActiveAttributeKey = onActiveAttributeKey ?? autocompleteCtx?.setActiveAttributeKey
	const resolvedOnActiveResourceAttributeKey =
		onActiveResourceAttributeKey ?? autocompleteCtx?.setActiveResourceAttributeKey

	const {
		suggestions,
		activeIndex,
		isOpen,
		syncCursor,
		onTextChange,
		onFocus,
		onBlur,
		onKeyIntent,
		applySuggestion,
	} = useWhereClauseAutocomplete({
		expression: value,
		dataSource,
		values: resolvedValues,
		scope: autocompleteScope,
		maxSuggestions,
		onActiveAttributeKey: resolvedOnActiveAttributeKey,
		onActiveResourceAttributeKey: resolvedOnActiveResourceAttributeKey,
	})

	const handleApplySuggestion = React.useCallback(
		(index: number) => {
			const result = applySuggestion(index)
			if (!result) return

			onChange(result.expression)

			const schedule = (callback: () => void) => {
				if (typeof window !== "undefined" && window.requestAnimationFrame) {
					window.requestAnimationFrame(() => callback())
					return
				}
				globalThis.setTimeout(callback, 0)
			}

			schedule(() => {
				const textarea = textAreaRef.current
				if (!textarea) return
				textarea.focus()
				textarea.setSelectionRange(result.cursor, result.cursor)
			})
		},
		[applySuggestion, onChange],
	)

	return (
		<div className={cn("relative", className)}>
			<Textarea
				ref={textAreaRef}
				rows={rows}
				value={value}
				placeholder={placeholder}
				className={textareaClassName}
				aria-label={ariaLabel}
				onFocus={(event) => {
					autocompleteValuesCtx?.activate?.()
					onFocus()
					syncCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
				}}
				onBlur={() => onBlur()}
				onChange={(event) => {
					const pos = event.currentTarget.selectionStart ?? event.currentTarget.value.length
					onTextChange(event.target.value, pos)
					onChange(event.target.value)
				}}
				onClick={(event) =>
					syncCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
				}
				onSelect={(event) =>
					syncCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
				}
				onKeyUp={(event) => {
					if (isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
						return
					}
					syncCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
				}}
				onKeyDown={(event) => {
					// Always prevent Enter from inserting newlines (where clauses are single-line)
					if (event.key === "Enter") {
						event.preventDefault()
						if (isOpen && suggestions.length > 0) {
							handleApplySuggestion(activeIndex)
						}
						return
					}

					if (event.key === "ArrowDown") {
						if (onKeyIntent("next")) event.preventDefault()
						return
					}

					if (event.key === "ArrowUp") {
						if (onKeyIntent("prev")) event.preventDefault()
						return
					}

					if (event.key === "Tab") {
						if (onKeyIntent("accept")) event.preventDefault()
						return
					}

					if (event.key === "Escape") {
						if (onKeyIntent("dismiss")) event.preventDefault()
					}
				}}
			/>

			{isOpen && (
				<div
					role="listbox"
					aria-label="Where clause suggestions"
					className="absolute z-50 mt-1 max-h-52 w-full overflow-auto border bg-popover text-popover-foreground shadow-md"
				>
					{suggestions.map((suggestion, index) => (
						<button
							key={suggestion.id}
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							className={cn(
								"flex w-full items-center justify-between px-2 py-1 text-left text-xs",
								index === activeIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-accent/60",
							)}
							onMouseDown={(event) => {
								event.preventDefault()
							}}
							onClick={() => handleApplySuggestion(index)}
						>
							<span className="font-mono">{suggestion.label}</span>
							<span className="text-[10px] uppercase text-muted-foreground">
								{suggestion.kind}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

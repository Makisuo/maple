import * as React from "react"
import * as ReactDOM from "react-dom"

import { Textarea } from "@maple/ui/components/ui/textarea"
import type {
	WhereClauseAutocompleteScope,
	WhereClauseAutocompleteValues,
} from "@/lib/query-builder/where-clause-autocomplete"
import type { QueryBuilderDataSource } from "@maple/query-engine/query-builder"
import { useAutocompleteContextOptional } from "@/hooks/use-autocomplete-context"
import { useAutocompleteValuesContextOptional } from "@/hooks/use-autocomplete-values"
import { useWhereClauseAutocomplete } from "@/hooks/use-where-clause-autocomplete"
import { WHERE_CLAUSE_TOKEN_COLOR, tokenizeWhereClause } from "@/lib/query-builder/where-clause-highlight"
import { cn } from "@maple/ui/lib/utils"

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
	/**
	 * Render syntax highlighting over the textarea. The overlay mirrors the
	 * Textarea's default padding, so combine only with font/size classes in
	 * `textareaClassName` — custom padding there would misalign the overlay.
	 */
	highlight?: boolean
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
	highlight = false,
}: WhereClauseEditorProps) {
	const textAreaRef = React.useRef<HTMLTextAreaElement | null>(null)
	const highlightRef = React.useRef<HTMLDivElement | null>(null)

	const highlightTokens = React.useMemo(
		() => (highlight ? tokenizeWhereClause(value) : []),
		[highlight, value],
	)
	const isHighlighting = highlight && value.length > 0

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

	// The suggestion list is portalled to the body: the editor is routinely
	// embedded in scroll containers that clip (and, with `scrollFade`, mask) an
	// absolutely positioned child — the dialog panel's ScrollArea being the worst
	// offender. Anchor it to the textarea by hand instead.
	const [listboxPosition, setListboxPosition] = React.useState<ListboxPosition | null>(null)

	React.useLayoutEffect(() => {
		if (!isOpen) {
			setListboxPosition(null)
			return
		}

		const measure = () => {
			const textarea = textAreaRef.current
			if (!textarea) return
			setListboxPosition(computeListboxPosition(textarea.getBoundingClientRect()))
		}

		measure()

		// The textarea is `resize-y` in most embeddings, and dragging it fires
		// neither of the window events.
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure())
		if (observer && textAreaRef.current) observer.observe(textAreaRef.current)

		window.addEventListener("resize", measure)
		// Capture so ancestor scroll containers — not just the document — retarget.
		window.addEventListener("scroll", measure, true)
		return () => {
			observer?.disconnect()
			window.removeEventListener("resize", measure)
			window.removeEventListener("scroll", measure, true)
		}
	}, [isOpen, suggestions.length])

	const listbox = isOpen && (
		<div
			role="listbox"
			aria-label="Where clause suggestions"
			className="fixed z-[60] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
			style={listboxPosition ?? undefined}
		>
			{suggestions.map((suggestion, index) => (
				<button
					key={suggestion.id}
					type="button"
					role="option"
					aria-selected={index === activeIndex}
					className={cn(
						"flex w-full items-center justify-between px-2 py-1 text-left text-xs",
						index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
					)}
					onMouseDown={(event) => {
						event.preventDefault()
					}}
					onClick={() => handleApplySuggestion(index)}
				>
					<span className="font-mono">{suggestion.label}</span>
					<span className="text-[10px] uppercase text-muted-foreground">{suggestion.kind}</span>
				</button>
			))}
		</div>
	)

	return (
		<div className={cn("relative", className)}>
			<Textarea
				ref={textAreaRef}
				rows={rows}
				value={value}
				placeholder={placeholder}
				className={cn(
					textareaClassName,
					// Keep the caret visible while the overlay paints the glyphs.
					isHighlighting && "text-transparent caret-foreground",
				)}
				aria-label={ariaLabel}
				onScroll={(event) => {
					const overlay = highlightRef.current
					if (!overlay) return
					overlay.scrollTop = event.currentTarget.scrollTop
					overlay.scrollLeft = event.currentTarget.scrollLeft
				}}
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

			{isHighlighting && (
				<div
					ref={highlightRef}
					aria-hidden
					// Mirrors the Textarea's inner metrics: 1px border + the default
					// px/py, plus the same wrapper font classes so wrapping matches.
					className={cn(
						"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] text-base break-words whitespace-pre-wrap sm:text-sm",
						textareaClassName,
					)}
				>
					{highlightTokens.map((token, index) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
							key={index}
							style={{ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] }}
						>
							{token.text}
						</span>
					))}
				</div>
			)}

			{listbox && typeof document !== "undefined" && ReactDOM.createPortal(listbox, document.body)}
		</div>
	)
}

interface ListboxPosition {
	left: number
	width: number
	maxHeight: number
	top?: number
	bottom?: number
}

/** Matches the previous `max-h-52`. */
const LISTBOX_MAX_HEIGHT = 208
const LISTBOX_GAP = 4
/** Below this much room under the textarea, opening upward reads better. */
const LISTBOX_MIN_SPACE_BELOW = 160

function computeListboxPosition(rect: DOMRect): ListboxPosition {
	const viewportHeight = window.innerHeight
	const spaceBelow = viewportHeight - rect.bottom - LISTBOX_GAP
	const spaceAbove = rect.top - LISTBOX_GAP
	const flipUp = spaceBelow < LISTBOX_MIN_SPACE_BELOW && spaceAbove > spaceBelow
	const available = flipUp ? spaceAbove : spaceBelow

	return {
		left: rect.left,
		width: rect.width,
		maxHeight: Math.max(0, Math.min(LISTBOX_MAX_HEIGHT, available - LISTBOX_GAP)),
		...(flipUp
			? { bottom: viewportHeight - rect.top + LISTBOX_GAP }
			: { top: rect.bottom + LISTBOX_GAP }),
	}
}

import * as React from "react"

import {
	applyWhereClauseSuggestion,
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteScope,
	type WhereClauseAutocompleteSuggestion,
	type WhereClauseAutocompleteValues,
} from "@/lib/query-builder/where-clause-autocomplete"
import type { QueryBuilderDataSource } from "@/lib/query-builder/model"

export interface UseWhereClauseAutocompleteOptions {
	expression: string
	dataSource: QueryBuilderDataSource
	values?: WhereClauseAutocompleteValues
	scope?: WhereClauseAutocompleteScope
	maxSuggestions?: number
	onActiveAttributeKey?: (key: string | null) => void
	onActiveResourceAttributeKey?: (key: string | null) => void
}

export interface UseWhereClauseAutocompleteReturn {
	suggestions: WhereClauseAutocompleteSuggestion[]
	activeIndex: number
	isOpen: boolean
	syncCursor: (position: number) => void
	onTextChange: (text: string, cursorPosition: number) => void
	onFocus: () => void
	onBlur: () => void
	onKeyIntent: (intent: "next" | "prev" | "accept" | "dismiss") => boolean
	applySuggestion: (index: number) => { expression: string; cursor: number } | null
}

export function useWhereClauseAutocomplete({
	expression,
	dataSource,
	values,
	scope,
	maxSuggestions,
	onActiveAttributeKey,
	onActiveResourceAttributeKey,
}: UseWhereClauseAutocompleteOptions): UseWhereClauseAutocompleteReturn {
	const [cursor, setCursor] = React.useState(expression.length)
	const [isFocused, setIsFocused] = React.useState(false)
	const [isDismissed, setIsDismissed] = React.useState(false)
	const [activeIndex, setActiveIndex] = React.useState(0)

	const lastAttrKeyRef = React.useRef<string | null>(null)
	const lastResourceKeyRef = React.useRef<string | null>(null)

	const notifyActiveKeys = React.useCallback(
		(expr: string, cursorPos: number) => {
			const ac = getWhereClauseAutocomplete({
				expression: expr,
				cursor: cursorPos,
				dataSource,
				values,
				scope,
				maxSuggestions,
			})

			const nextAttrKey = ac.context === "value" && ac.key?.startsWith("attr.") ? ac.key.slice(5) : null
			if (nextAttrKey !== lastAttrKeyRef.current) {
				lastAttrKeyRef.current = nextAttrKey
				onActiveAttributeKey?.(nextAttrKey)
			}

			const nextResourceKey =
				ac.context === "value" && ac.key?.startsWith("resource.") ? ac.key.slice(9) : null
			if (nextResourceKey !== lastResourceKeyRef.current) {
				lastResourceKeyRef.current = nextResourceKey
				onActiveResourceAttributeKey?.(nextResourceKey)
			}
		},
		[dataSource, maxSuggestions, onActiveAttributeKey, onActiveResourceAttributeKey, scope, values],
	)

	const autocomplete = React.useMemo(
		() =>
			getWhereClauseAutocomplete({
				expression,
				cursor,
				dataSource,
				values,
				scope,
				maxSuggestions,
			}),
		[cursor, dataSource, expression, maxSuggestions, scope, values],
	)

	const suggestions = autocomplete.suggestions
	const isOpen = isFocused && !isDismissed && suggestions.length > 0

	const syncCursor = React.useCallback(
		(position: number) => {
			setCursor(position)
			setIsDismissed(false)
			setActiveIndex(0)
			notifyActiveKeys(expression, position)
		},
		[expression, notifyActiveKeys],
	)

	const onTextChange = React.useCallback(
		(text: string, cursorPosition: number) => {
			setCursor(cursorPosition)
			setIsDismissed(false)
			setActiveIndex(0)
			notifyActiveKeys(text, cursorPosition)
		},
		[notifyActiveKeys],
	)

	const onFocus = React.useCallback(() => {
		setIsFocused(true)
		setIsDismissed(false)
	}, [])

	const onBlur = React.useCallback(() => {
		setIsFocused(false)
	}, [])

	const applySuggestion = React.useCallback(
		(index: number): { expression: string; cursor: number } | null => {
			const suggestion = suggestions[index]
			if (!suggestion) return null

			const applied = applyWhereClauseSuggestion({
				expression,
				context: autocomplete.context,
				replaceStart: autocomplete.replaceStart,
				replaceEnd: autocomplete.replaceEnd,
				suggestion,
			})

			setCursor(applied.cursor)
			setIsDismissed(false)
			notifyActiveKeys(applied.expression, applied.cursor)

			return applied
		},
		[
			autocomplete.context,
			autocomplete.replaceEnd,
			autocomplete.replaceStart,
			expression,
			notifyActiveKeys,
			suggestions,
		],
	)

	/** Returns true if the intent was handled (caller should preventDefault). */
	const onKeyIntent = React.useCallback(
		(intent: "next" | "prev" | "accept" | "dismiss"): boolean => {
			if (!isOpen || suggestions.length === 0) {
				if (intent === "accept" && suggestions.length > 0 && isFocused && !isDismissed) {
					// Edge case: accept when open
				}
				return false
			}

			switch (intent) {
				case "next":
					setActiveIndex((current) => (current + 1) % suggestions.length)
					return true
				case "prev":
					setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
					return true
				case "accept":
					applySuggestion(activeIndex)
					return true
				case "dismiss":
					setIsDismissed(true)
					return true
			}
		},
		[activeIndex, applySuggestion, isDismissed, isFocused, isOpen, suggestions.length],
	)

	return {
		suggestions,
		activeIndex,
		isOpen,
		syncCursor,
		onTextChange,
		onFocus,
		onBlur,
		onKeyIntent,
		applySuggestion,
	}
}

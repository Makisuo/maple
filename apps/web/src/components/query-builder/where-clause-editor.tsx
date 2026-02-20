import * as React from "react"

import { Textarea } from "@maple/ui/components/ui/textarea"
import {
  applyWhereClauseSuggestion,
  getWhereClauseAutocomplete,
  type WhereClauseAutocompleteScope,
  type WhereClauseAutocompleteValues,
} from "@/lib/query-builder/where-clause-autocomplete"
import type { QueryBuilderDataSource } from "@/lib/query-builder/model"
import { cn } from "@maple/ui/utils"

interface WhereClauseEditorProps {
  dataSource: QueryBuilderDataSource
  value: string
  onChange: (value: string) => void
  values?: WhereClauseAutocompleteValues
  autocompleteScope?: WhereClauseAutocompleteScope
  onActiveAttributeKey?: (key: string | null) => void
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
  placeholder,
  rows = 2,
  maxSuggestions,
  className,
  textareaClassName,
  ariaLabel,
}: WhereClauseEditorProps) {
  const textAreaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const [cursor, setCursor] = React.useState(value.length)
  const [isFocused, setIsFocused] = React.useState(false)
  const [isDismissed, setIsDismissed] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)

  React.useEffect(() => {
    setCursor((current) => Math.min(current, value.length))
  }, [value])

  const autocomplete = React.useMemo(
    () =>
      getWhereClauseAutocomplete({
        expression: value,
        cursor,
        dataSource,
        values,
        scope: autocompleteScope,
        maxSuggestions,
      }),
    [autocompleteScope, cursor, dataSource, maxSuggestions, value, values],
  )

  // Notify parent when user is editing a value for an attr.* key
  React.useEffect(() => {
    if (!onActiveAttributeKey) return
    if (autocomplete.context === "value" && autocomplete.key?.startsWith("attr.")) {
      onActiveAttributeKey(autocomplete.key.slice(5))
    } else {
      onActiveAttributeKey(null)
    }
  }, [autocomplete.context, autocomplete.key, onActiveAttributeKey])

  const suggestions = autocomplete.suggestions
  const isOpen = isFocused && !isDismissed && suggestions.length > 0

  React.useEffect(() => {
    setActiveIndex(0)
  }, [autocomplete.context, autocomplete.query, suggestions.length])

  const syncCursor = React.useCallback((target: HTMLTextAreaElement) => {
    setCursor(target.selectionStart ?? target.value.length)
    setIsDismissed(false)
  }, [])

  const applySuggestion = React.useCallback(
    (index: number) => {
      const suggestion = suggestions[index]
      if (!suggestion) {
        return
      }

      const applied = applyWhereClauseSuggestion({
        expression: value,
        context: autocomplete.context,
        replaceStart: autocomplete.replaceStart,
        replaceEnd: autocomplete.replaceEnd,
        suggestion,
      })

      onChange(applied.expression)
      setCursor(applied.cursor)
      setIsDismissed(false)

      const schedule = (callback: () => void) => {
        if (typeof window !== "undefined" && window.requestAnimationFrame) {
          window.requestAnimationFrame(() => callback())
          return
        }

        globalThis.setTimeout(callback, 0)
      }

      schedule(() => {
        const textarea = textAreaRef.current
        if (!textarea) {
          return
        }

        textarea.focus()
        textarea.setSelectionRange(applied.cursor, applied.cursor)
      })
    },
    [autocomplete.context, autocomplete.replaceEnd, autocomplete.replaceStart, onChange, suggestions, value],
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
          setIsFocused(true)
          setIsDismissed(false)
          syncCursor(event.currentTarget)
        }}
        onBlur={() => {
          setIsFocused(false)
        }}
        onChange={(event) => {
          syncCursor(event.currentTarget)
          onChange(event.target.value)
        }}
        onClick={(event) => syncCursor(event.currentTarget)}
        onSelect={(event) => syncCursor(event.currentTarget)}
        onKeyUp={(event) => syncCursor(event.currentTarget)}
        onKeyDown={(event) => {
          if (!isOpen || suggestions.length === 0) {
            return
          }

          if (event.key === "ArrowDown") {
            event.preventDefault()
            setActiveIndex((current) => (current + 1) % suggestions.length)
            return
          }

          if (event.key === "ArrowUp") {
            event.preventDefault()
            setActiveIndex((current) =>
              (current - 1 + suggestions.length) % suggestions.length,
            )
            return
          }

          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            applySuggestion(activeIndex)
            return
          }

          if (event.key === "Escape") {
            event.preventDefault()
            setIsDismissed(true)
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
              onClick={() => applySuggestion(index)}
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

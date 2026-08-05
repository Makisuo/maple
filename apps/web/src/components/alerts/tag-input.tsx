import { useId, useRef, useState, type KeyboardEvent } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Badge } from "@maple/ui/components/ui/badge"

import { XmarkIcon } from "@/components/icons"

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32

/** Trim, lowercase, and clamp a raw input value to the canonical tag form. */
function canonicalize(raw: string): string {
	return raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
}

interface TagInputProps {
	value: string[]
	onChange: (tags: string[]) => void
	/** Existing org tags surfaced as native autocomplete suggestions. */
	suggestions?: string[]
	id?: string
	placeholder?: string
}

/**
 * Compact token field for free-form rule tags. Type a tag and press Enter (or
 * comma) to commit it; Backspace on an empty field removes the last chip. Tags
 * are lowercased and deduped so they match what the list groups on. Existing
 * tags are offered via a native datalist, degrading to a plain input when none
 * are passed.
 */
export function TagInput({ value, onChange, suggestions, id, placeholder }: TagInputProps) {
	const [draft, setDraft] = useState("")
	const inputRef = useRef<HTMLInputElement>(null)
	const listId = useId()

	const commit = (raw: string) => {
		const tag = canonicalize(raw)
		setDraft("")
		if (tag.length === 0 || value.includes(tag) || value.length >= MAX_TAGS) return
		onChange([...value, tag])
	}

	const removeAt = (index: number) => {
		onChange(value.filter((_, i) => i !== index))
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault()
			commit(draft)
		} else if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
			removeAt(value.length - 1)
		}
	}

	const availableSuggestions = suggestions?.filter((s) => !value.includes(s)) ?? []

	return (
		<div
			className={cn(
				"flex min-h-8.5 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 text-sm",
				"ring-ring/24 transition-shadow focus-within:border-ring focus-within:ring-[3px] dark:bg-input/32",
			)}
			onClick={() => inputRef.current?.focus()}
		>
			{value.map((tag, index) => (
				<Badge key={tag} variant="secondary" size="sm" className="gap-1 pr-1">
					{tag}
					<button
						type="button"
						aria-label={`Remove ${tag}`}
						onClick={(e) => {
							e.stopPropagation()
							removeAt(index)
						}}
						className="-mr-0.5 rounded-sm text-muted-foreground hover:text-foreground"
					>
						<XmarkIcon size={11} />
					</button>
				</Badge>
			))}
			<input
				ref={inputRef}
				id={id}
				list={availableSuggestions.length > 0 ? listId : undefined}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={handleKeyDown}
				onBlur={() => commit(draft)}
				placeholder={value.length === 0 ? (placeholder ?? "Add tags…") : undefined}
				className="min-w-[80px] flex-1 bg-transparent leading-6 outline-none placeholder:text-muted-foreground/72"
			/>
			{availableSuggestions.length > 0 && (
				<datalist id={listId}>
					{availableSuggestions.map((s) => (
						<option key={s} value={s} />
					))}
				</datalist>
			)}
		</div>
	)
}

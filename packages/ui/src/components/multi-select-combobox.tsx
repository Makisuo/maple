"use client"

import * as React from "react"

import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import {
	Combobox,
	ComboboxChip,
	ComboboxChips,
	ComboboxChipsInput,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
	useComboboxAnchor,
} from "./ui/combobox"
import { ChevronDownIcon, MagnifierIcon } from "./icons"

export interface MultiSelectOption<T extends string = string> {
	value: T
	/** Falls back to `value`. Also what the typeahead filter matches against. */
	label?: string
	/** Chip text when the selected chip should read differently from the list row. */
	chipLabel?: React.ReactNode
	/** Rendered before the label in both the chip and the list item. */
	adornment?: React.ReactNode
	/** Rendered right-aligned inside the list item (facet counts, secondary text). */
	meta?: React.ReactNode
}

export interface MultiSelectComboboxProps<T extends string = string> {
	/** Wired to the chips input so a sibling `<Label htmlFor>` focuses the field. */
	id?: string
	value: readonly T[]
	onChange: (values: T[]) => void
	options: readonly MultiSelectOption<T>[]
	/**
	 * `chips` renders selections inline as removable chips (form fields).
	 * `trigger` renders a compact button whose popup holds the search input —
	 * for toolbars, where an inline field would change the row's height.
	 */
	mode?: "chips" | "trigger"
	/** Trigger-mode button content, rendered before the selected-count badge. */
	triggerLabel?: React.ReactNode
	/** Chips-mode placeholder, shown in the inline input. */
	placeholder?: string
	/** Trigger-mode placeholder for the search input inside the popup. */
	searchPlaceholder?: string
	emptyMessage: string
	disabled?: boolean
	/** When set, the popup gets a footer button that clears the selection. */
	clearLabel?: (count: number) => string
	/** Extra content pinned below the list (pagination, status lines). */
	footer?: React.ReactNode
	className?: string
	/** Escape hatch for per-surface chip/item styling (e.g. `font-mono`). */
	chipsClassName?: string
	itemClassName?: string
}

/**
 * Shared multi-select built on the coss combobox primitives (`./ui/combobox`).
 *
 * Every "pick many values from a searchable list" surface routes through here so
 * they share one keyboard model and one set of a11y semantics. Filtering is left
 * to Base UI — passing `items` + `itemToStringLabel` gives typeahead for free, so
 * call sites must not hand-roll a `.filter()` over the options.
 */
export function MultiSelectCombobox<T extends string = string>({
	id,
	value,
	onChange,
	options,
	mode = "chips",
	triggerLabel,
	placeholder,
	searchPlaceholder = "Search…",
	emptyMessage,
	disabled = false,
	clearLabel,
	footer,
	className,
	chipsClassName,
	itemClassName,
}: MultiSelectComboboxProps<T>): React.ReactElement {
	const anchor = useComboboxAnchor()

	const { items, byValue, labelFor } = React.useMemo(() => {
		const map = new Map<T, MultiSelectOption<T>>()
		for (const option of options) map.set(option.value, option)
		return {
			byValue: map,
			items: options.map((option) => option.value),
			labelFor: (v: T) => map.get(v)?.label ?? v,
		}
	}, [options])

	const handleChange = React.useCallback(
		(next: unknown) => {
			if (disabled) return
			onChange(next as T[])
		},
		[disabled, onChange],
	)

	const renderItem = (item: T) => {
		const option = byValue.get(item)
		return (
			<ComboboxItem className={itemClassName} key={item} value={item}>
				<span className="flex min-w-0 items-center gap-2">
					{option?.adornment}
					<span className="min-w-0 flex-1 truncate">{option?.label ?? item}</span>
					{option?.meta !== undefined && (
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{option.meta}
						</span>
					)}
				</span>
			</ComboboxItem>
		)
	}

	const popupFooter = (
		<>
			{footer && <div className="border-border border-t p-1.5">{footer}</div>}
			{clearLabel && value.length > 0 && (
				<div className="border-border border-t p-1.5">
					<Button
						className="w-full justify-start text-muted-foreground"
						onClick={() => handleChange([])}
						size="sm"
						variant="ghost"
					>
						{clearLabel(value.length)}
					</Button>
				</div>
			)}
		</>
	)

	if (mode === "trigger") {
		return (
			<Combobox
				disabled={disabled}
				items={items}
				itemToStringLabel={labelFor}
				multiple
				onValueChange={handleChange}
				value={value as T[]}
			>
				<ComboboxTrigger
					className={className}
					render={<Button className="shrink-0 gap-1.5" size="sm" variant="outline" />}
				>
					{triggerLabel}
					<ChevronDownIcon className="text-muted-foreground" size={14} />
				</ComboboxTrigger>
				<ComboboxContent align="start" className="w-64">
					<div className="border-border border-b p-2">
						<ComboboxInput
							placeholder={searchPlaceholder}
							showTrigger={false}
							size="sm"
							startAddon={<MagnifierIcon />}
						/>
					</div>
					<ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
					<ComboboxList>{renderItem}</ComboboxList>
					{popupFooter}
				</ComboboxContent>
			</Combobox>
		)
	}

	return (
		<div className={className}>
			<Combobox
				items={items}
				itemToStringLabel={labelFor}
				multiple
				onValueChange={handleChange}
				value={value as T[]}
			>
				{/* Disabled keeps the field mounted rather than unmounting it, so cards
				    holding several conditionally-disabled pickers never reflow. */}
				<ComboboxChips
					aria-disabled={disabled || undefined}
					className={cn(disabled && "pointer-events-none opacity-60", chipsClassName)}
					ref={anchor}
				>
					{value.map((item) => {
						const option = byValue.get(item)
						return (
							<ComboboxChip key={item}>
								{option?.adornment}
								{option?.chipLabel ?? option?.label ?? item}
							</ComboboxChip>
						)
					})}
					<ComboboxChipsInput disabled={disabled} id={id} placeholder={placeholder} />
				</ComboboxChips>
				<ComboboxContent anchor={anchor}>
					<ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
					<ComboboxList>{renderItem}</ComboboxList>
					{popupFooter}
				</ComboboxContent>
			</Combobox>
		</div>
	)
}

import * as React from "react"

import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { GROUP_BY_OPTIONS, type QueryBuilderDataSource } from "@maple/query-engine/query-builder"

interface GroupByMultiSelectProps {
	/** Wired to the field's `<Label htmlFor>` so clicking the label focuses the input. */
	id?: string
	value: string[]
	onChange: (value: string[]) => void
	dataSource: QueryBuilderDataSource
	attributeKeys?: string[]
	/** Optional placeholder shown when no chips are selected. */
	placeholder?: string
	/** Disable the picker (e.g. when scoping by an explicit service list). */
	disabled?: boolean
	/** Optional className passed to the wrapping div. */
	className?: string
}

/**
 * Multi-select combobox for choosing dashboard / alert group-by dimensions.
 * Combines the static built-in dimensions for the data source with any
 * dynamically discovered attribute keys (rendered as `attr.<key>`).
 *
 * Lifted from `dashboard-builder/config/query-panel.tsx` so the alert form
 * can reuse the exact same picker — keeping grouping semantics in sync
 * across dashboards and alerts.
 */
export function GroupByMultiSelect({
	id,
	value,
	onChange,
	dataSource,
	attributeKeys,
	placeholder = "service.name",
	disabled = false,
	className,
}: GroupByMultiSelectProps) {
	const options = React.useMemo(() => {
		const labelMap = new Map<string, string>()
		for (const opt of GROUP_BY_OPTIONS[dataSource]) {
			if (opt.value === "none") continue
			labelMap.set(opt.value, opt.label)
		}
		for (const key of attributeKeys ?? []) {
			labelMap.set(`attr.${key}`, `attr.${key}`)
		}
		// The chip keeps the raw dimension key (mono, matching how it appears in a
		// query), while the list row shows the human-readable label.
		return Array.from(labelMap, ([optionValue, label]) => ({
			value: optionValue,
			label,
			chipLabel: optionValue,
		}))
	}, [dataSource, attributeKeys])

	return (
		<MultiSelectCombobox
			chipsClassName="text-xs font-mono"
			className={className ?? "flex-1 min-w-[140px]"}
			disabled={disabled}
			emptyMessage="No fields found."
			id={id}
			itemClassName="font-mono"
			onChange={onChange}
			options={options}
			placeholder={value.length === 0 ? placeholder : ""}
			value={value}
		/>
	)
}

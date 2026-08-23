import { useState } from "react"

import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import {
	FUNNEL_SESSION_DIMENSIONS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	type FunnelBreakdownBy,
	type FunnelSessionDimension,
} from "./definition"

const ATTRIBUTE_PREFIX = "attribute:"
const NONE = "__none__"
const ATTRIBUTE = "__attribute__"

/**
 * Breakdown: none, one of the session dimensions, or `attribute:<key>` typed
 * by hand — the attribute keys on `track()` events are the customer's own
 * vocabulary and there is no cheap way to list them. Mounted by the dashboard
 * funnel panel's Breakdown add-on.
 *
 * "Attribute…" and the key it needs are two interactions, so the mode is held
 * here and only a NON-EMPTY key becomes a `breakdownBy`. Emitting the bare
 * `attribute:` prefix would break the funnel down by `Attributes['']`, which no
 * event carries: every person lands in the `(none)` group, and the aggregation
 * that produced it was pure waste.
 */
export function BreakdownPicker({
	value,
	onChange,
	className,
}: {
	value: FunnelBreakdownBy | undefined
	onChange: (value: FunnelBreakdownBy | undefined) => void
	className?: string
}) {
	const fromValue = value !== undefined && value.startsWith(ATTRIBUTE_PREFIX)
	const [attributeMode, setAttributeMode] = useState(fromValue)
	const [attributeKey, setAttributeKey] = useState(fromValue ? value.slice(ATTRIBUTE_PREFIX.length) : "")
	// The local mode only survives while nothing else is selected, so a value
	// that changes under us (Back, a shared link, a reopened widget) wins over a
	// stale "Attribute…".
	const isAttribute = fromValue || (attributeMode && value === undefined)
	const selected = isAttribute ? ATTRIBUTE : value === undefined ? NONE : value
	const items = {
		[NONE]: "None",
		...FUNNEL_SESSION_DIMENSION_LABEL,
		[ATTRIBUTE]: "Attribute…",
	}
	const emitAttribute = (key: string) => {
		const trimmed = key.trim()
		onChange(trimmed.length > 0 ? `${ATTRIBUTE_PREFIX}${trimmed}` : undefined)
	}
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			<Select
				items={items}
				value={selected}
				onValueChange={(next) => {
					if (next === NONE) {
						setAttributeMode(false)
						onChange(undefined)
					} else if (next === ATTRIBUTE) {
						setAttributeMode(true)
						emitAttribute(attributeKey)
					} else {
						const dimension = FUNNEL_SESSION_DIMENSIONS.find((candidate) => candidate === next)
						if (dimension !== undefined) {
							setAttributeMode(false)
							onChange(dimension)
						}
					}
				}}
			>
				<SelectTrigger size="sm" className="w-32 min-w-0" aria-label="Break down by">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NONE}>None</SelectItem>
					{FUNNEL_SESSION_DIMENSIONS.map((dimension: FunnelSessionDimension) => (
						<SelectItem key={dimension} value={dimension}>
							{FUNNEL_SESSION_DIMENSION_LABEL[dimension]}
						</SelectItem>
					))}
					<SelectItem value={ATTRIBUTE}>Attribute…</SelectItem>
				</SelectContent>
			</Select>
			{isAttribute ? (
				<Input
					size="sm"
					value={attributeKey}
					onChange={(event) => {
						setAttributeKey(event.target.value)
						emitAttribute(event.target.value)
					}}
					placeholder="attribute key, e.g. plan"
					aria-label="Breakdown attribute key"
					className="w-40 font-mono text-xs"
				/>
			) : null}
		</div>
	)
}

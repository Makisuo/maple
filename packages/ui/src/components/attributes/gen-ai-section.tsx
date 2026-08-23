"use client"

import { AttributeRow } from "./attributes-table"
import type { GenAiGroup } from "../../lib/gen-ai"

/**
 * The `gen_ai.*` attributes of a span, read as fields rather than as a map.
 *
 * Same rows as the raw table — same grid, same click-to-copy, same
 * `renderValue` hook — with one difference that is the whole point: the key
 * column is a plain-language label, and the fields are grouped by what they
 * describe. The full key is still what a copy yields.
 */
export function GenAiSection({
	groups,
	searchQuery,
}: {
	groups: ReadonlyArray<GenAiGroup>
	searchQuery?: string
}) {
	const matched = filterGroups(groups, searchQuery)
	if (matched.length === 0) return null

	return (
		<div className="space-y-1.5">
			<h4 className="text-xs font-medium tracking-wide text-foreground/70">AI Attributes</h4>
			<div className="divide-y divide-border/60 overflow-hidden rounded-md border">
				{matched.map((group) => (
					<div key={group.id}>
						<div className="px-1.5 py-1.5 text-[11px] font-semibold tracking-wide text-foreground/80">
							{group.label}
						</div>
						<div className="divide-y divide-border/40 border-t border-border/60 bg-muted/15">
							{group.fields.map((field) => (
								<AttributeRow
									key={field.key}
									attrKey={field.key}
									value={field.rawValue}
									displayKey={field.label}
									displayValue={field.value}
									plainKey
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

/** Matches on the label too, since the label is what the reader can see. */
function filterGroups(groups: ReadonlyArray<GenAiGroup>, searchQuery?: string): ReadonlyArray<GenAiGroup> {
	if (!searchQuery) return groups
	const q = searchQuery.toLowerCase()
	return groups
		.map((group) => ({
			...group,
			fields: group.fields.filter(
				(field) =>
					field.key.toLowerCase().includes(q) ||
					field.label.toLowerCase().includes(q) ||
					field.value.toLowerCase().includes(q),
			),
		}))
		.filter((group) => group.fields.length > 0)
}

import { useMemo } from "react"

import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { Toggle } from "@maple/ui/components/ui/toggle"

import { LayersIcon, TagIcon } from "@/components/icons"
import type { TagFacet } from "@/lib/alerts/tag-grouping"

interface AlertTagControlsProps {
	facets: TagFacet[]
	selected: string[]
	onSelectedChange: (tags: string[]) => void
	grouped: boolean
	onGroupedChange: (grouped: boolean) => void
}

/**
 * Tag filter (multi-select combobox) + "Group by tag" toggle, shared by the
 * Rules and Monitor tabs. Renders nothing until at least one tag exists so the
 * controls stay out of the way for orgs that never tag their rules.
 */
export function AlertTagControls({
	facets,
	selected,
	onSelectedChange,
	grouped,
	onGroupedChange,
}: AlertTagControlsProps) {
	const options = useMemo(() => facets.map((facet) => ({ value: facet.name, meta: facet.count })), [facets])

	if (facets.length === 0 && selected.length === 0) return null

	return (
		<div className="flex items-center gap-2">
			<MultiSelectCombobox
				clearLabel={(count) => `Clear ${count} selected`}
				emptyMessage="No matching tags"
				mode="trigger"
				onChange={onSelectedChange}
				options={options}
				searchPlaceholder="Filter tags…"
				triggerAriaLabel="Tags"
				triggerLabel={
					<>
						<TagIcon size={14} />
						Tags
						{selected.length > 0 && (
							<Badge className="tabular-nums" size="sm" variant="secondary">
								{selected.length}
							</Badge>
						)}
					</>
				}
				value={selected}
			/>

			<Toggle
				aria-label="Group by tag"
				className={cn("gap-1.5", grouped && "text-foreground")}
				onPressedChange={onGroupedChange}
				pressed={grouped}
				size="sm"
				variant="outline"
			>
				<LayersIcon size={14} />
				Group by tag
			</Toggle>
		</div>
	)
}

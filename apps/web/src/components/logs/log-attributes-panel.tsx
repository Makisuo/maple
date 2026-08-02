import { useState } from "react"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import type { Log } from "@/api/warehouse/logs"

interface LogAttributesPanelProps {
	log: Log
}

/**
 * Searchable log + resource attribute tables. Owns its own search state;
 * remount (via `key`) to reset it when the displayed log changes.
 */
export function LogAttributesPanel({ log }: LogAttributesPanelProps) {
	const [attrSearch, setAttrSearch] = useState("")

	const hasAttributes =
		Object.keys(log.logAttributes).length > 0 || Object.keys(log.resourceAttributes).length > 0

	return (
		<div className="space-y-3">
			{hasAttributes && (
				<SearchInput
					value={attrSearch}
					onValueChange={setAttrSearch}
					placeholder="Search attributes..."
				/>
			)}

			<AttributesTable
				attributes={log.logAttributes}
				title="Log Attributes"
				searchQuery={attrSearch}
				groupByNamespace
			/>

			<ResourceAttributesSection
				attributes={log.resourceAttributes}
				searchQuery={attrSearch}
				groupByNamespace
			/>
		</div>
	)
}

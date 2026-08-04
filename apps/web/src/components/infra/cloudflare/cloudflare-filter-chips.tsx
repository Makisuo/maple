// Cloudflare's adapter over the shared active-filter rail
// (`infra/primitives/filter-chips.tsx`). The rail owns the look and the
// overflow behaviour; this owns the Cloudflare filter vocabulary.

import { FilterChipRail } from "../primitives/filter-chips"
import { activeFilterChips, type ActiveFilterChip, type CloudflareFilters } from "./filters"

export function CloudflareFilterChips({
	filters,
	onRemove,
	onClear,
}: {
	filters: CloudflareFilters
	onRemove: (chip: ActiveFilterChip) => void
	onClear: () => void
}) {
	return <FilterChipRail chips={activeFilterChips(filters)} onRemove={onRemove} onClear={onClear} />
}

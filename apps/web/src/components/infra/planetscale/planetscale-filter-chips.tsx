// PlanetScale's adapter over the shared active-filter rail
// (`infra/primitives/filter-chips.tsx`).

import { FilterChipRail } from "../primitives/filter-chips"
import { activeFilterChips, type ActiveFilterChip, type PlanetScaleFilters } from "./filters"

export function PlanetScaleFilterChips({
	filters,
	onRemove,
	onClear,
}: {
	filters: PlanetScaleFilters
	onRemove: (chip: ActiveFilterChip) => void
	onClear: () => void
}) {
	return <FilterChipRail chips={activeFilterChips(filters)} onRemove={onRemove} onClear={onClear} />
}

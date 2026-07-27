// Per-panel scope marker.
//
// Cloudflare's stored dimensions are single-dimension slices, not one cube: a
// `by_path` row carries a path and nothing else, and the latency gauges carry
// only `quantile`. So a path filter genuinely cannot narrow the cache chart,
// and nothing narrows latency.
//
// A filter sidebar implies "everything to my right obeys these". Rather than
// let that be quietly false, every panel says what it is actually scoped to:
// the filters it applied, or a muted `zone-wide` explaining what it couldn't.
// The API hands us `ignoredFilters` for exactly this.

import { ScopeChip } from "../primitives/scope-chip"
import {
	activeFilterChips,
	filterKeysFromServer,
	FILTER_SECTION_LABEL,
	type CloudflareFilterKey,
	type CloudflareFilters,
} from "./filters"

const listNames = (keys: ReadonlyArray<CloudflareFilterKey>): string => {
	const names = keys.map((key) => FILTER_SECTION_LABEL[key].toLowerCase())
	if (names.length <= 1) return names[0] ?? ""
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export function PanelScope({
	filters,
	ignoredFilters,
	/** What this panel measures, for the explanation — e.g. "Latency is measured across the zone". */
	reason,
}: {
	filters: CloudflareFilters
	/** Server-side filter keys this panel could not apply. */
	ignoredFilters?: ReadonlyArray<string>
	reason?: string
}) {
	const active = activeFilterChips(filters)
	if (active.length === 0) return null

	const ignored = filterKeysFromServer(ignoredFilters)
	const honored = active.filter((chip) => !ignored.includes(chip.key))

	const explanation = (
		<>
			{reason ? `${reason}. ` : ""}
			{listNames(ignored)} {ignored.length === 1 ? "does" : "do"} not apply here.
		</>
	)

	if (honored.length === 0) {
		return (
			<ScopeChip tone="muted" explanation={explanation}>
				zone-wide
			</ScopeChip>
		)
	}

	const shown = honored.slice(0, 2)
	const extra = honored.length - shown.length

	return (
		<span className="inline-flex items-center gap-1">
			{shown.map((chip) => (
				<ScopeChip key={`${chip.key}:${chip.value}`} className="max-w-[20ch] truncate">
					{chip.label}
				</ScopeChip>
			))}
			{extra > 0 ? <ScopeChip tone="muted">+{extra}</ScopeChip> : null}
			{ignored.length > 0 ? (
				<ScopeChip tone="muted" explanation={explanation}>
					partial
				</ScopeChip>
			) : null}
		</span>
	)
}

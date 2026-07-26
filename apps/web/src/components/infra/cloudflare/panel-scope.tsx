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

import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import {
	activeFilterChips,
	filterKeysFromServer,
	FILTER_SECTION_LABEL,
	type CloudflareFilterKey,
	type CloudflareFilters,
} from "./filters"

const MARKER_CLASS =
	"inline-flex items-center rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px]"

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

	if (honored.length === 0) {
		return (
			<Tooltip>
				<TooltipTrigger
					render={<span />}
					className={`${MARKER_CLASS} cursor-default text-muted-foreground/70`}
				>
					zone-wide
				</TooltipTrigger>
				<TooltipContent className="max-w-[32ch]">
					{reason ? `${reason}. ` : ""}
					{listNames(ignored)} {ignored.length === 1 ? "does" : "do"} not apply here.
				</TooltipContent>
			</Tooltip>
		)
	}

	const shown = honored.slice(0, 2)
	const extra = honored.length - shown.length

	return (
		<span className="inline-flex items-center gap-1">
			{shown.map((chip) => (
				<span
					key={`${chip.key}:${chip.value}`}
					className={`${MARKER_CLASS} max-w-[20ch] truncate text-muted-foreground`}
				>
					{chip.label}
				</span>
			))}
			{extra > 0 ? (
				<span className={`${MARKER_CLASS} text-muted-foreground/70`}>+{extra}</span>
			) : null}
			{ignored.length > 0 ? (
				<Tooltip>
					<TooltipTrigger
						render={<span />}
						className={`${MARKER_CLASS} cursor-default text-muted-foreground/70`}
					>
						partial
					</TooltipTrigger>
					<TooltipContent className="max-w-[32ch]">
						{reason ? `${reason}. ` : ""}
						{listNames(ignored)} {ignored.length === 1 ? "does" : "do"} not apply here.
					</TooltipContent>
				</Tooltip>
			) : null}
		</span>
	)
}

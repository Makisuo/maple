import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"

import { ArrowRotateAnticlockwiseIcon, ChevronDownIcon } from "@/components/icons"
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/dashboard-controls/search-params"

/** `0` is the off sentinel, so it has no duration to render. */
export function formatRefreshInterval(seconds: DashboardRefreshIntervalSeconds): string {
	if (seconds === 0) return "Off"
	return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`
}

interface RefreshIntervalPickerProps {
	value: DashboardRefreshIntervalSeconds
	onChange: (value: DashboardRefreshIntervalSeconds) => void
	/**
	 * The dashboard's stored cadence, when the caller has one. Rendered as a hint
	 * on the matching row so a viewer overriding via `?refresh=` can see what the
	 * board itself is set to.
	 */
	savedDefault?: DashboardRefreshIntervalSeconds
}

export function RefreshIntervalPicker({ value, onChange, savedDefault }: RefreshIntervalPickerProps) {
	const isOn = value > 0

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="sm"
						title={
							isOn
								? `Auto-refreshing every ${formatRefreshInterval(value)}`
								: "Auto-refresh is off"
						}
						aria-label={
							isOn ? `Auto-refresh every ${formatRefreshInterval(value)}` : "Auto-refresh off"
						}
					/>
				}
			>
				{/* Same reload glyph as the button beside it, so the pair reads as one
				    control: reload now, or reload every N. A clock here read as a
				    second time-range picker next to the real one. */}
				<ArrowRotateAnticlockwiseIcon className="size-3.5" />
				{/* Always labelled. An icon-only trigger left the viewer guessing what
				    it did, which is the whole point of the word "Auto". */}
				<span>Auto</span>
				{isOn && <span className="font-medium tabular-nums">{formatRefreshInterval(value)}</span>}
				<ChevronDownIcon className="size-3 opacity-60" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				{/* Values are strings on the wire because Base UI's RadioGroup compares
				    by identity and the caller round-trips them through the URL. */}
				<DropdownMenuRadioGroup
					value={String(value)}
					onValueChange={(next) => onChange(Number(next) as DashboardRefreshIntervalSeconds)}
				>
					{/* Names the group for screen readers as well as sighted viewers, so
					    the menu is self-explanatory even reached straight from the URL.
					    Safe inside a RadioGroup: the label only self-wraps in a Group
					    when nothing above it provided the context. */}
					<DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
					{REFRESH_INTERVAL_OPTIONS.map((seconds) => (
						<DropdownMenuRadioItem key={seconds} value={String(seconds)}>
							<span>{formatRefreshInterval(seconds)}</span>
							{savedDefault === seconds && (
								<span className="text-muted-foreground text-[10px]">default</span>
							)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"

import { ChevronDownIcon, ClockIcon } from "@/components/icons"
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/dashboard-controls/search-params"

/**
 * `0` is the off sentinel, so it has no duration to render — the trigger falls
 * back to the icon alone rather than showing "0s".
 */
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
						aria-label={
							isOn ? `Auto-refresh every ${formatRefreshInterval(value)}` : "Auto-refresh off"
						}
					/>
				}
			>
				<ClockIcon className="size-3.5" />
				{isOn && <span>{formatRefreshInterval(value)}</span>}
				<ChevronDownIcon className="size-3 opacity-60" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-32">
				{/* Values are strings on the wire because Base UI's RadioGroup compares
				    by identity and the caller round-trips them through the URL. */}
				<DropdownMenuRadioGroup
					value={String(value)}
					onValueChange={(next) => onChange(Number(next) as DashboardRefreshIntervalSeconds)}
				>
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

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
import { cn } from "@maple/ui/lib/utils"

import { ArrowRotateAnticlockwiseIcon, ChevronDownIcon } from "@/components/icons"
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/dashboard-controls/search-params"

import { usePageRefreshContext } from "./page-refresh-context"

/** `0` is the off sentinel, so it has no duration to render. */
export function formatRefreshInterval(seconds: DashboardRefreshIntervalSeconds): string {
	if (seconds === 0) return "Off"
	return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`
}

interface RefreshControlsProps {
	onReload: () => void
	isReloading?: boolean
	value: DashboardRefreshIntervalSeconds
	onChange: (value: DashboardRefreshIntervalSeconds) => void
	/**
	 * The dashboard's stored cadence, when the caller has one. Rendered as a hint
	 * on the matching row so a viewer overriding via `?refresh=` can see what the
	 * board itself is set to.
	 */
	savedDefault?: DashboardRefreshIntervalSeconds
}

/**
 * Reload now, or reload every N — as one split button, the way Grafana draws it.
 *
 * The halves are joined rather than merely adjacent because that is what carries
 * the meaning: a standalone cadence dropdown beside a standalone reload button
 * reads as two unrelated controls, and next to the time-range picker its icon
 * read as a second time control. Attached to "Reload", "30s" can only mean one
 * thing.
 */
export function RefreshControls({
	onReload,
	isReloading = false,
	value,
	onChange,
	savedDefault,
}: RefreshControlsProps) {
	const isOn = value > 0

	return (
		<div className="flex items-center">
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onReload}
				disabled={isReloading}
				// Flush with the cadence half: square the shared edge, and square the
				// `before:` inset highlight with it or a stray rounded corner shows
				// through. `focus-visible:z-10` lifts the ring above the neighbour's
				// border, which the -1px overlap would otherwise clip.
				className="relative rounded-r-none before:rounded-r-none focus-visible:z-10"
			>
				<ArrowRotateAnticlockwiseIcon className={cn("size-3.5", isReloading && "animate-spin")} />
				<span>Reload</span>
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="outline"
							size="sm"
							title={
								isOn
									? `Reloading every ${formatRefreshInterval(value)}`
									: "Auto-refresh is off"
							}
							aria-label={
								isOn
									? `Auto-refresh every ${formatRefreshInterval(value)}`
									: "Auto-refresh off"
							}
							// -1px so the two borders collapse into one seam rather than
							// stacking into a 2px rule.
							className="relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10"
						/>
					}
				>
					<span className={cn("tabular-nums", !isOn && "text-muted-foreground")}>
						{formatRefreshInterval(value)}
					</span>
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
		</div>
	)
}

/**
 * The signed-in board's binding: reload comes from the page refresh context, so
 * one tick fans out to every tile. The share page has no such context and drives
 * `RefreshControls` directly.
 */
export function PageRefreshControls(props: Omit<RefreshControlsProps, "onReload" | "isReloading">) {
	const { isReloading, reload } = usePageRefreshContext()
	return <RefreshControls onReload={reload} isReloading={isReloading} {...props} />
}

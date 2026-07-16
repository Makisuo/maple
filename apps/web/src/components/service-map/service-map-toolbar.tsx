import { memo } from "react"
import { cn } from "@maple/ui/utils"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { ArrowRotateAnticlockwiseIcon, XmarkIcon } from "@/components/icons"
import type { ServiceMapColorMode } from "./service-map-utils"
import type { DeclutterFocus } from "./service-map-declutter"

/** Discrete low-traffic thresholds (% of the peak edge rate); 0 = show all. */
export const TRAFFIC_FILTER_STEPS = [0, 0.1, 1, 5] as const

const trafficStepLabel = (pct: number): string => (pct === 0 ? "All traffic" : `> ${pct}% of peak`)

export interface ServiceMapToolbarProps {
	colorMode: ServiceMapColorMode
	onColorModeChange: (mode: ServiceMapColorMode) => void
	onResort: () => void
	/** Focusable service ids (real services only — no db/aggregate nodes). */
	services: string[]
	focus: DeclutterFocus | null
	onFocusChange: (focus: DeclutterFocus | null) => void
	minTrafficPct: number
	onMinTrafficPctChange: (pct: number) => void
	hiddenNodeCount: number
	hiddenEdgeCount: number
}

const chipClass =
	"flex items-center gap-2 bg-card/90 backdrop-blur-sm border border-border rounded-md px-2 py-1"

/**
 * Floating toolbar in the map's top-left corner: color-by, re-sort, service
 * focus (dim/hide non-neighbors), and the low-traffic filter with its
 * hidden-count chip.
 */
export const ServiceMapToolbar = memo(function ServiceMapToolbar({
	colorMode,
	onColorModeChange,
	onResort,
	services,
	focus,
	onFocusChange,
	minTrafficPct,
	onMinTrafficPctChange,
	hiddenNodeCount,
	hiddenEdgeCount,
}: ServiceMapToolbarProps) {
	return (
		<div className="absolute top-2 left-2 z-50 flex flex-wrap items-center gap-2 pr-2">
			<div className={chipClass}>
				<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
					Color by
				</span>
				<Select value={colorMode} onValueChange={(v) => onColorModeChange(v as ServiceMapColorMode)}>
					<SelectTrigger
						size="sm"
						className="h-6 min-w-0 text-[11px] capitalize border-0 bg-transparent px-1.5"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="service">Service</SelectItem>
						<SelectItem value="health">Health</SelectItem>
						<SelectItem value="platform">Platform</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<button
				type="button"
				onClick={onResort}
				title="Re-sort — discard manual positions and auto-arrange"
				className="flex h-[34px] items-center gap-1.5 bg-card/90 backdrop-blur-sm border border-border rounded-md px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowRotateAnticlockwiseIcon size={12} />
				Re-sort
			</button>

			{/* Focus: pick a service → dim (or hide) everything outside its neighborhood. */}
			{focus ? (
				<div className={cn(chipClass, "py-[3px]")}>
					<ServiceDot serviceName={focus.serviceId} className="size-1.5 shrink-0" />
					<span className="max-w-40 truncate text-[11px] font-medium text-foreground">
						{focus.serviceId}
					</span>
					<div className="flex overflow-hidden rounded border border-border">
						{([1, 2] as const).map((hops) => (
							<button
								key={hops}
								type="button"
								onClick={() => onFocusChange({ ...focus, hops })}
								className={cn(
									"px-1.5 py-0.5 text-[10px] font-medium transition-colors",
									focus.hops === hops
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{hops}-hop
							</button>
						))}
					</div>
					<div className="flex overflow-hidden rounded border border-border">
						{(["dim", "hide"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								title={
									mode === "dim"
										? "Fade services outside the neighborhood"
										: "Remove them and re-layout the neighborhood"
								}
								onClick={() => onFocusChange({ ...focus, mode })}
								className={cn(
									"px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors",
									focus.mode === mode
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{mode}
							</button>
						))}
					</div>
					<button
						type="button"
						onClick={() => onFocusChange(null)}
						title="Clear focus"
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						<XmarkIcon size={12} />
					</button>
				</div>
			) : (
				<Combobox<string | null>
					value={null}
					onValueChange={(value) => {
						if (typeof value === "string" && value.length > 0) {
							onFocusChange({ serviceId: value, hops: 1, mode: "dim" })
						}
					}}
				>
					<ComboboxInput
						placeholder="Focus service…"
						className="h-[34px] w-40 bg-card/90 backdrop-blur-sm text-[11px]"
					/>
					<ComboboxContent>
						<ComboboxEmpty>No services found.</ComboboxEmpty>
						<ComboboxList>
							{services.map((svc) => (
								<ComboboxItem key={svc} value={svc}>
									<ServiceDot serviceName={svc} className="size-1.5" />
									{svc}
								</ComboboxItem>
							))}
						</ComboboxList>
					</ComboboxContent>
				</Combobox>
			)}

			{/* Low-traffic filter */}
			<div className={chipClass}>
				<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
					Traffic
				</span>
				<Select
					items={TRAFFIC_FILTER_STEPS.map((pct) => ({
						value: String(pct),
						label: trafficStepLabel(pct),
					}))}
					value={String(minTrafficPct)}
					onValueChange={(v) => onMinTrafficPctChange(Number(v))}
				>
					<SelectTrigger size="sm" className="h-6 min-w-0 text-[11px] border-0 bg-transparent px-1.5">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TRAFFIC_FILTER_STEPS.map((pct) => (
							<SelectItem key={pct} value={String(pct)}>
								{trafficStepLabel(pct)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{(hiddenNodeCount > 0 || hiddenEdgeCount > 0) && (
				<Tooltip>
					<TooltipTrigger
						onClick={() => onMinTrafficPctChange(0)}
						className="flex h-[34px] items-center gap-1.5 bg-card/90 backdrop-blur-sm border border-dashed border-border rounded-md px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
					>
						{hiddenNodeCount > 0 ? `${hiddenNodeCount} services · ` : ""}
						{hiddenEdgeCount} edges hidden
					</TooltipTrigger>
					<TooltipContent side="bottom">
						<p>Below {minTrafficPct}% of the peak edge rate — click to show all</p>
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	)
})

import { memo } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Separator } from "@maple/ui/components/ui/separator"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { ArrowRotateAnticlockwiseIcon, MagnifierIcon, PaletteIcon, XmarkIcon } from "@/components/icons"
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

/**
 * The map's control bar. It sits in the layout above the canvas — mirroring the
 * legend strip below it — rather than floating over the graph, where it used to
 * cover the top-left nodes and wrap into a second row of mismatched chips.
 *
 * Left half narrows the graph (focus a service, drop low-traffic edges); right
 * half is presentation (color-by, re-layout).
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
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
			{focus ? (
				<>
					<span className="flex h-7 items-center gap-1.5 rounded-lg border border-input bg-background pr-1 pl-2 text-sm dark:bg-input/32">
						<ServiceDot serviceName={focus.serviceId} className="size-1.5 shrink-0" />
						<span className="max-w-40 truncate font-medium">{focus.serviceId}</span>
						<button
							type="button"
							aria-label="Clear focus"
							onClick={() => onFocusChange(null)}
							className="-mr-0.5 flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
						>
							<XmarkIcon size={12} />
						</button>
					</span>
					<Select
						items={[
							{ value: "1", label: "1 hop" },
							{ value: "2", label: "2 hops" },
						]}
						value={String(focus.hops)}
						onValueChange={(v) => onFocusChange({ ...focus, hops: Number(v) === 2 ? 2 : 1 })}
					>
						<SelectTrigger size="sm" className="min-w-0" aria-label="Focus depth">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="1">1 hop</SelectItem>
							<SelectItem value="2">2 hops</SelectItem>
						</SelectContent>
					</Select>
					<Tooltip>
						<TooltipTrigger
							render={
								<Toggle
									variant="outline"
									size="sm"
									className="px-2.5"
									pressed={focus.mode === "hide"}
									onPressedChange={(pressed) =>
										onFocusChange({ ...focus, mode: pressed ? "hide" : "dim" })
									}
								>
									Hide rest
								</Toggle>
							}
						/>
						<TooltipContent side="bottom">
							<p>
								Remove everything outside the neighborhood and re-layout, instead of fading it
							</p>
						</TooltipContent>
					</Tooltip>
				</>
			) : (
				// The wrapper carries the responsive width, not the input: the input's
				// own `w-full` is what tells `ComboboxInputGroup` to stop sizing to
				// content, and a responsive class there would match at every width.
				<div className="w-full sm:w-52">
					<Combobox<string | null>
						value={null}
						onValueChange={(value) => {
							if (typeof value === "string" && value.length > 0) {
								onFocusChange({ serviceId: value, hops: 1, mode: "dim" })
							}
						}}
					>
						<ComboboxInput
							size="sm"
							showTrigger={false}
							placeholder="Focus a service…"
							startAddon={<MagnifierIcon size={14} strokeWidth={2} />}
							className="w-full"
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
				</div>
			)}

			<Separator orientation="vertical" className="hidden h-5 sm:block" />

			<Select
				items={TRAFFIC_FILTER_STEPS.map((pct) => ({
					value: String(pct),
					label: trafficStepLabel(pct),
				}))}
				value={String(minTrafficPct)}
				onValueChange={(v) => onMinTrafficPctChange(Number(v))}
			>
				<SelectTrigger size="sm" className="min-w-0" aria-label="Traffic threshold">
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

			{(hiddenNodeCount > 0 || hiddenEdgeCount > 0) && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								onClick={() => onMinTrafficPctChange(0)}
							>
								{hiddenNodeCount > 0 ? `${hiddenNodeCount} services · ` : ""}
								{hiddenEdgeCount} edges hidden
							</Button>
						}
					/>
					<TooltipContent side="bottom">
						<p>Below {minTrafficPct}% of the peak edge rate — click to show all</p>
					</TooltipContent>
				</Tooltip>
			)}

			<div className="ml-auto flex items-center gap-2">
				<Select value={colorMode} onValueChange={(v) => onColorModeChange(v as ServiceMapColorMode)}>
					<SelectTrigger size="sm" className="min-w-0 capitalize" aria-label="Color nodes by">
						<PaletteIcon size={14} className="text-muted-foreground" />
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="service">Service</SelectItem>
						<SelectItem value="health">Health</SelectItem>
						<SelectItem value="platform">Platform</SelectItem>
					</SelectContent>
				</Select>

				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="outline"
								size="sm"
								onClick={onResort}
								aria-label="Re-sort"
								className="max-sm:size-8 max-sm:px-0"
							>
								<ArrowRotateAnticlockwiseIcon size={13} />
								<span className="max-sm:sr-only">Re-sort</span>
							</Button>
						}
					/>
					<TooltipContent side="bottom">
						<p>Discard manual positions and auto-arrange</p>
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	)
})

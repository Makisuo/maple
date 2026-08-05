import { useRef, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { ArrowsSwapIcon } from "@/components/icons"
import { formatCost, formatTokens } from "./journey-format"
import type { JourneyModel, JourneySummaryData } from "./journey-model"

// ---------------------------------------------------------------------------
// The context rail: a scrubbable map of the whole journey, then who spent what.
//
// Every figure here is derived from the timeline rather than asked of the
// server — the summary carries the agent and model *sets*, not their shares,
// and a second round trip to learn that one agent took eight turns would be a
// query for something already on the page.
// ---------------------------------------------------------------------------

const LABEL = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
const VALUE = "font-mono text-[11px] text-muted-foreground tabular-nums"

export function JourneyRail({
	model,
	summary,
	visibleRowIds,
	onSelectRow,
}: {
	model: JourneyModel
	summary: JourneySummaryData | null
	visibleRowIds: ReadonlySet<string>
	onSelectRow: (rowId: string) => void
}) {
	const hasCost = model.agents.some((agent) => agent.cost != null) || summary?.cost != null

	return (
		<div className="flex flex-col gap-6">
			<JourneyMap
				model={model}
				visibleRowIds={visibleRowIds}
				onSelectRow={onSelectRow}
				live={summary?.status === "running"}
			/>

			{model.agents.length > 0 && (
				<RailSection label="Agents" trailing={String(model.agents.length)}>
					{model.agents.map((agent) => (
						<div key={agent.name} className="flex items-center gap-2">
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: agent.color }}
							/>
							<span className="min-w-0 grow truncate font-mono text-xs text-foreground">
								{agent.name}
							</span>
							<span className={cn(VALUE, "w-14 shrink-0 text-right")}>
								{agent.turns} turn{agent.turns === 1 ? "" : "s"}
							</span>
							{hasCost && (
								<span className={cn(VALUE, "w-12 shrink-0 text-right text-foreground/75")}>
									{formatCost(agent.cost) ?? "—"}
								</span>
							)}
						</div>
					))}
				</RailSection>
			)}

			{model.models.length > 0 && (
				<RailSection label="Models" trailing={String(model.models.length)}>
					{model.models.map((entry) => (
						<div key={entry.name} className="flex items-center gap-2">
							<span className="min-w-0 grow truncate font-mono text-xs text-foreground">
								{entry.name}
							</span>
							<span className={cn(VALUE, "w-14 shrink-0 text-right")}>
								{entry.turns} turn{entry.turns === 1 ? "" : "s"}
							</span>
							{hasCost && (
								<span className={cn(VALUE, "w-12 shrink-0 text-right text-foreground/75")}>
									{formatCost(entry.cost) ?? "—"}
								</span>
							)}
						</div>
					))}
					{model.divergentModelTurns > 0 && (
						<div className="flex items-center gap-1.5 pt-0.5">
							<ArrowsSwapIcon size={11} className="shrink-0 text-warning" />
							<span className="font-mono text-[11px] text-warning-foreground">
								{model.divergentModelTurns} turn{model.divergentModelTurns === 1 ? "" : "s"}{" "}
								served a different model
							</span>
						</div>
					)}
				</RailSection>
			)}

			<RailSection label="Tokens & cost" trailing={formatTokens(model.tokens.total)}>
				<TokenBar tokens={model.tokens} />
				<TokenRow swatch="bg-input" label="input · cached" value={model.tokens.cachedInput} />
				<TokenRow swatch="bg-foreground/40" label="input · fresh" value={model.tokens.freshInput} />
				{model.tokens.reasoning > 0 && (
					<TokenRow
						swatch="bg-primary/40"
						label="output · reasoning"
						value={model.tokens.reasoning}
					/>
				)}
				<TokenRow swatch="bg-primary" label="output · visible" value={model.tokens.visibleOutput} />
				<div className="flex items-baseline gap-2 border-t border-border pt-2">
					<span className="min-w-0 grow font-mono text-xs text-muted-foreground">
						{model.tokens.cachedShare != null && model.tokens.cachedShare > 0
							? `${Math.round(model.tokens.cachedShare * 100)}% of input was cached`
							: "no cached input"}
					</span>
					{formatCost(summary?.cost) != null && (
						<span className="font-mono text-[13px] text-foreground tabular-nums">
							{formatCost(summary?.cost)}
						</span>
					)}
				</div>
			</RailSection>

			<div className="flex flex-col gap-1 border-t border-border pt-4">
				<span className={VALUE}>
					{summary?.traceCount === 1 ? "1 trace" : `${summary?.traceCount ?? 0} traces`} ·{" "}
					{summary?.spanCount ?? 0} spans
				</span>
				{(summary?.providers.length ?? 0) > 0 && (
					<span className={VALUE}>via {summary?.providers.join(", ")}</span>
				)}
			</div>
		</div>
	)
}

function RailSection({
	label,
	trailing,
	children,
}: {
	label: string
	trailing?: string
	children: React.ReactNode
}) {
	return (
		<section className="flex flex-col gap-2.5 border-t border-border pt-5 first:border-t-0 first:pt-0">
			<div className="flex items-baseline gap-2">
				<h3 className={cn(LABEL, "grow")}>{label}</h3>
				{trailing != null && <span className={VALUE}>{trailing}</span>}
			</div>
			{children}
		</section>
	)
}

function TokenRow({ swatch, label, value }: { swatch: string; label: string; value: number }) {
	return (
		<div className="flex items-center gap-2">
			<span aria-hidden className={cn("size-1.5 shrink-0 rounded-[2px]", swatch)} />
			<span className="min-w-0 grow font-mono text-xs text-muted-foreground">{label}</span>
			<span className="shrink-0 font-mono text-xs text-foreground tabular-nums">
				{formatTokens(value)}
			</span>
		</div>
	)
}

function TokenBar({ tokens }: { tokens: JourneyModel["tokens"] }) {
	const total = Math.max(
		1,
		tokens.cachedInput + tokens.freshInput + tokens.reasoning + tokens.visibleOutput,
	)
	const parts = [
		{ key: "cached", value: tokens.cachedInput, className: "bg-input" },
		{ key: "fresh", value: tokens.freshInput, className: "bg-foreground/40" },
		{ key: "reasoning", value: tokens.reasoning, className: "bg-primary/40" },
		{ key: "visible", value: tokens.visibleOutput, className: "bg-primary" },
	]
	return (
		<div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-[3px]">
			{parts.map((part) =>
				part.value <= 0 ? null : (
					<span
						key={part.key}
						className={part.className}
						style={{ flexGrow: part.value / total }}
					/>
				),
			)}
		</div>
	)
}

/**
 * The journey map: one bar per event, length proportional to its duration,
 * coloured by what the time went into. It is an overview and a scrubber — the
 * shaded run marks what is on screen, and clicking a bar scrolls the timeline
 * to that event. On a 142-turn journey this is the only view of the whole
 * shape.
 */
function JourneyMap({
	model,
	visibleRowIds,
	onSelectRow,
	live,
}: {
	model: JourneyModel
	visibleRowIds: ReadonlySet<string>
	onSelectRow: (rowId: string) => void
	live: boolean
}) {
	const firstVisible = model.mapBars.findIndex((bar) => visibleRowIds.has(bar.rowId))
	const lastVisible = model.mapBars.reduce(
		(last, bar, index) => (visibleRowIds.has(bar.rowId) ? index : last),
		-1,
	)

	// Roving focus: the map is one tab stop, not three hundred. Arrow keys walk
	// the bars, Enter/Space scrolls the timeline — the same contract a listbox
	// gives, without pretending these 5px marks are a list of options.
	const listRef = useRef<HTMLDivElement | null>(null)
	const [focusIndex, setFocusIndex] = useState(0)
	const clampedFocus = Math.min(focusIndex, Math.max(0, model.mapBars.length - 1))

	const moveFocus = (next: number) => {
		const target = Math.max(0, Math.min(model.mapBars.length - 1, next))
		setFocusIndex(target)
		listRef.current?.querySelector<HTMLButtonElement>(`[data-map-bar="${target}"]`)?.focus()
	}

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		switch (event.key) {
			case "ArrowDown":
			case "ArrowRight":
				event.preventDefault()
				moveFocus(clampedFocus + 1)
				break
			case "ArrowUp":
			case "ArrowLeft":
				event.preventDefault()
				moveFocus(clampedFocus - 1)
				break
			case "Home":
				event.preventDefault()
				moveFocus(0)
				break
			case "End":
				event.preventDefault()
				moveFocus(model.mapBars.length - 1)
				break
			default:
				break
		}
	}

	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex items-baseline gap-2">
				<h3 className={cn(LABEL, "grow")}>Journey map</h3>
				<span className={VALUE}>
					{model.counts.turns} turns{live ? " · live" : ""}
				</span>
			</div>

			<div
				ref={listRef}
				role="group"
				aria-label="Journey map — arrow keys move between events"
				onKeyDown={onKeyDown}
				className="flex flex-col gap-1"
			>
				{model.mapBars.map((bar, index) => {
					const onScreen = index >= firstVisible && index <= lastVisible && firstVisible >= 0
					return (
						<button
							key={bar.rowId}
							type="button"
							data-map-bar={index}
							tabIndex={index === clampedFocus ? 0 : -1}
							onFocus={() => setFocusIndex(index)}
							onClick={() => onSelectRow(bar.rowId)}
							className={cn(
								"flex h-[5px] w-full items-center border-l pl-2",
								onScreen ? "border-l-primary" : "border-l-transparent",
							)}
							aria-label={`Scroll to event ${index + 1} of ${model.mapBars.length}`}
						>
							<span
								className={cn(
									"h-[5px] rounded-[2px]",
									bar.category === "failed"
										? "bg-severity-error"
										: bar.category === "tool"
											? "bg-info"
											: bar.category === "idle"
												? "border border-input"
												: "bg-primary",
								)}
								style={{ width: `${bar.widthPct}%` }}
							/>
						</button>
					)
				})}
			</div>

			<div className="flex items-center gap-1.5 pt-1">
				<span aria-hidden className="h-px w-2 shrink-0 bg-primary" />
				<span className={VALUE}>
					{firstVisible >= 0
						? `on screen · ${firstVisible + 1}–${lastVisible + 1} of ${model.mapBars.length}`
						: `${model.mapBars.length} events`}
				</span>
			</div>
		</section>
	)
}

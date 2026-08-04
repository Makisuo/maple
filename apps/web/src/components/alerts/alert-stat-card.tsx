import type { ReactNode } from "react"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/lib/utils"

type Tone = "default" | "critical" | "emerald" | "amber"

const valueToneClass: Record<Tone, string> = {
	default: "text-foreground",
	critical: "text-destructive",
	emerald: "text-success",
	amber: "text-warning",
}

export type AlertStatItem = {
	label: string
	value: ReactNode
	hint?: ReactNode
	tone?: Tone
}

/**
 * Flat, divider-separated summary row. Replaces the old "one card per single
 * value" grid (the hero-metric / identical-card-grid pattern the design system
 * rejects). Hairlines come from a `bg-border` backplate showing through a 1px
 * gap; cells stack on mobile and sit in a row from `sm` up. Numerals stay at a
 * restrained `text-xl` semibold — dense and numerical, not a marketing tile.
 */
export function AlertStatStrip({ items, className }: { items: AlertStatItem[]; className?: string }) {
	return (
		<div
			className={cn(
				"flex flex-col gap-px overflow-hidden rounded-lg border border-border bg-border sm:flex-row",
				className,
			)}
		>
			{items.map((item) => (
				<div key={item.label} className="flex flex-1 flex-col gap-2 bg-card px-5 py-4">
					<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
						{item.label}
					</span>
					<div className="flex items-baseline gap-2">
						<span
							className={cn(
								"text-xl font-semibold tabular-nums leading-none",
								valueToneClass[item.tone ?? "default"],
							)}
						>
							{item.value}
						</span>
						{item.hint && <span className="text-muted-foreground text-xs">{item.hint}</span>}
					</div>
				</div>
			))}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Status bar — flat one-row treatment that leads the Monitor / dashboard     */
/* -------------------------------------------------------------------------- */

export function AlertFiringHero({
	openCount,
	criticalCount,
	warningCount,
	rulesEnabled,
	rulesTotal,
	lastEvaluatedHint,
}: {
	openCount: number
	criticalCount: number
	warningCount: number
	rulesEnabled: number
	rulesTotal: number
	lastEvaluatedHint?: string
}) {
	const firing = openCount > 0

	const rulesSummary = (
		<span className="tabular-nums">
			<span className="text-foreground font-medium">{rulesEnabled}</span>
			<span className="text-muted-foreground/70">/</span>
			<span>{rulesTotal}</span>
			<span className="ml-1">rules</span>
		</span>
	)

	if (!firing) {
		return (
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
					<div className="flex min-w-0 items-center gap-3">
						<StatusDot tone="emerald" />
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							<span className="text-base font-semibold tracking-tight">All clear</span>
							<span className="text-muted-foreground text-sm">
								<span className="text-foreground font-medium tabular-nums">
									{rulesEnabled}
								</span>
								<span className="text-muted-foreground/70"> / </span>
								<span className="tabular-nums">{rulesTotal}</span>
								<span className="ml-1">rules watching</span>
							</span>
						</div>
					</div>
					{lastEvaluatedHint && (
						<span className="text-muted-foreground shrink-0 text-xs">{lastEvaluatedHint}</span>
					)}
				</CardContent>
			</Card>
		)
	}

	const firingLabel =
		[criticalCount > 0 && `${criticalCount} critical`, warningCount > 0 && `${warningCount} warning`]
			.filter(Boolean)
			.join(" · ") || `${openCount} open`

	return (
		<Card className="border-destructive/30 bg-destructive/[0.04]">
			<CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
				<div className="flex min-w-0 items-center gap-3">
					<StatusDot tone="destructive" pulse />
					<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
						<span className="text-destructive text-[11px] font-medium uppercase tracking-[0.16em]">
							Firing now
						</span>
						<span className="flex items-baseline gap-1.5">
							<span className="text-destructive text-2xl font-semibold tabular-nums leading-none">
								{openCount}
							</span>
							<span className="text-muted-foreground text-sm">
								{openCount === 1 ? "incident" : "incidents"}
							</span>
						</span>
						<span className="text-muted-foreground/40">·</span>
						<span className="text-muted-foreground text-sm">{firingLabel}</span>
					</div>
				</div>
				<div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
					{rulesSummary}
					{lastEvaluatedHint && (
						<>
							<span className="text-muted-foreground/40">·</span>
							<span>{lastEvaluatedHint}</span>
						</>
					)}
				</div>
			</CardContent>
		</Card>
	)
}

/**
 * Severity beacon. The firing halo uses the canonical `.infra-pulse`
 * (2.4s ease-out, reduced-motion-safe) rather than a generic ping, so it reads
 * as the same operator-terminal pulse used across the infra surfaces.
 */
function StatusDot({ tone, pulse = false }: { tone: "emerald" | "destructive"; pulse?: boolean }) {
	const dot = tone === "emerald" ? "bg-success" : "bg-destructive"
	return (
		<span className="relative flex size-3 shrink-0 items-center justify-center">
			{pulse && (
				<span
					aria-hidden
					className={cn("infra-pulse absolute size-3 rounded-full opacity-60", dot)}
				/>
			)}
			<span className={cn("relative size-2 rounded-full", dot)} />
		</span>
	)
}

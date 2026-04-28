import type { ReactNode } from "react"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/utils"

type Tone = "default" | "critical" | "emerald" | "amber"

const valueToneClass: Record<Tone, string> = {
	default: "text-foreground",
	critical: "text-destructive",
	emerald: "text-emerald-500",
	amber: "text-amber-500",
}

export function AlertStatCard({
	label,
	value,
	hint,
	tone = "default",
	icon,
	indicator,
	className,
	children,
}: {
	label: string
	value: ReactNode
	hint?: ReactNode
	tone?: Tone
	icon?: ReactNode
	indicator?: ReactNode
	className?: string
	children?: ReactNode
}) {
	return (
		<Card className={className}>
			<CardContent className="px-5">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
						{label}
					</span>
					{indicator ?? (icon ? <span className="text-muted-foreground">{icon}</span> : null)}
				</div>
				<div className="mt-3 flex items-baseline gap-2">
					<span className={cn("text-3xl font-bold tabular-nums", valueToneClass[tone])}>
						{value}
					</span>
					{hint && <span className="text-muted-foreground text-sm">{hint}</span>}
				</div>
				{children}
			</CardContent>
		</Card>
	)
}

/* -------------------------------------------------------------------------- */
/*  Hero firing card — dominant treatment when something is on fire           */
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

	if (!firing) {
		return (
			<Card className="relative ring-emerald-500/25">
				<span
					aria-hidden
					className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-transparent"
				/>
				<CardContent className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5">
					<div className="flex items-center gap-3 min-w-0">
						<StatusDot tone="emerald" />
						<div className="flex flex-col gap-0.5 min-w-0">
							<div className="flex items-center gap-2 text-base font-semibold tracking-tight">
								All services healthy
								<span className="rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-500/90">
									OK
								</span>
							</div>
							<div className="text-muted-foreground text-xs">
								<span className="tabular-nums text-foreground font-medium">
									{rulesEnabled}
								</span>
								<span className="text-muted-foreground/70"> / </span>
								<span className="tabular-nums">{rulesTotal}</span>
								<span className="ml-1">rules watching</span>
								{lastEvaluatedHint && (
									<>
										<span className="mx-2 text-muted-foreground/40">·</span>
										<span>{lastEvaluatedHint}</span>
									</>
								)}
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
		)
	}

	const firingLabel =
		[criticalCount > 0 && `${criticalCount} critical`, warningCount > 0 && `${warningCount} warning`]
			.filter(Boolean)
			.join(" · ") || `${openCount} open`

	return (
		<Card className="relative ring-destructive/35">
			<span
				aria-hidden
				className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-r from-destructive/[0.10] via-destructive/[0.02] to-transparent"
			/>
			<CardContent className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5">
				<div className="flex items-center gap-4 min-w-0">
					<StatusDot tone="destructive" pulse />
					<div className="flex flex-col gap-0.5 min-w-0">
						<div className="text-destructive text-[10px] font-medium uppercase tracking-[0.18em]">
							Firing now
						</div>
						<div className="flex items-baseline gap-2.5 leading-none">
							<span className="text-destructive text-3xl font-bold tabular-nums leading-none">
								{openCount}
							</span>
							<span className="text-muted-foreground text-sm truncate">
								{openCount === 1 ? "incident" : "incidents"}
								<span className="mx-1.5 text-muted-foreground/40">·</span>
								{firingLabel}
							</span>
						</div>
					</div>
				</div>
				<div className="text-muted-foreground text-xs flex flex-col items-end gap-0.5 shrink-0">
					<div className="tabular-nums">
						<span className="text-foreground font-medium">{rulesEnabled}</span>
						<span className="text-muted-foreground/70"> / </span>
						<span>{rulesTotal}</span>
						<span className="ml-1">rules</span>
					</div>
					{lastEvaluatedHint && <div>{lastEvaluatedHint}</div>}
				</div>
			</CardContent>
		</Card>
	)
}

function StatusDot({ tone, pulse = false }: { tone: "emerald" | "destructive"; pulse?: boolean }) {
	const colors =
		tone === "emerald"
			? { bg: "bg-emerald-500", halo: "bg-emerald-500/15" }
			: { bg: "bg-destructive", halo: "bg-destructive/20" }
	return (
		<span className="relative flex size-8 shrink-0 items-center justify-center">
			<span className={cn("absolute size-6 rounded-full", colors.halo)} />
			{pulse && (
				<span className={cn("absolute size-6 animate-ping rounded-full opacity-60", colors.halo)} />
			)}
			<span className={cn("relative size-2 rounded-full", colors.bg)} />
		</span>
	)
}

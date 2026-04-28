import * as React from "react"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { SeverityLevel } from "../format"

type Tone = SeverityLevel | "neutral"

const VALUE_TONE: Record<Tone, string> = {
	neutral: "text-foreground",
	ok: "text-foreground",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
}

const SPARK_COLOR: Record<Tone, string> = {
	neutral: "var(--primary)",
	ok: "var(--severity-info)",
	warn: "var(--severity-warn)",
	crit: "var(--severity-error)",
}

interface StatRailProps {
	children: React.ReactNode
	className?: string
}

export function StatRail({ children, className }: StatRailProps) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card",
				"md:grid-cols-4 md:divide-y-0",
				className,
			)}
		>
			{children}
		</div>
	)
}

interface StatRailItemProps {
	eyebrow: string
	value: string
	tone?: Tone
	delta?: React.ReactNode
	spark?: ReadonlyArray<number>
	subline?: React.ReactNode
	delay?: number
}

export function StatRailItem({
	eyebrow,
	value,
	tone = "neutral",
	delta,
	spark,
	subline,
	delay,
}: StatRailItemProps) {
	return (
		<div
			className={cn("relative px-5 py-4 animate-in fade-in slide-in-from-bottom-1 duration-500")}
			style={delay ? { animationDelay: `${delay}ms`, animationFillMode: "backwards" } : undefined}
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-[11px] font-medium text-muted-foreground">{eyebrow}</span>
				{delta ? (
					<span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
						{delta}
					</span>
				) : null}
			</div>
			<div className="mt-2 flex items-end justify-between gap-3">
				<div
					className={cn(
						"font-mono text-[26px] font-semibold tabular-nums leading-none tracking-[-0.01em]",
						VALUE_TONE[tone],
					)}
					style={{ fontFeatureSettings: "'tnum' 1" }}
				>
					{value}
				</div>
				{spark && spark.length > 1 ? (
					<BarSpark values={spark.slice(-28)} color={SPARK_COLOR[tone]} className="h-7 w-24" />
				) : (
					<div className="h-7 w-24" />
				)}
			</div>
			{subline ? <div className="mt-2 text-[11px] text-muted-foreground">{subline}</div> : null}
		</div>
	)
}

function BarSpark({
	values,
	color,
	className,
}: {
	values: ReadonlyArray<number>
	color: string
	className?: string
}) {
	if (!values.length) return <div className={className} />
	const max = Math.max(...values, 0.0001)
	const count = values.length
	const gap = 2
	const barWidth = Math.max((100 - gap * (count - 1)) / count, 0.5)
	return (
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className} aria-hidden>
			{values.map((v, i) => {
				const safe = Number.isFinite(v) && v >= 0 ? v : 0
				const ratio = max > 0 ? safe / max : 0
				const h = Math.max(ratio * 100, safe > 0 ? 5 : 0)
				const x = i * (barWidth + gap)
				const y = 100 - h
				return (
					<rect
						key={i}
						x={x}
						y={y}
						width={barWidth}
						height={h}
						rx={0}
						fill={color}
						opacity={0.3 + ratio * 0.7}
					/>
				)
			})}
		</svg>
	)
}

export function StatRailLoading() {
	return (
		<StatRail>
			{Array.from({ length: 4 }).map((_, i) => (
				<div key={i} className="px-5 py-4">
					<Skeleton className="h-3 w-16" />
					<div className="mt-3 flex items-end justify-between gap-3">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-24" />
					</div>
					<Skeleton className="mt-3 h-3 w-32" />
				</div>
			))}
		</StatRail>
	)
}

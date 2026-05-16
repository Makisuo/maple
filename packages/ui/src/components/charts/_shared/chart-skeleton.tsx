import { cn } from "../../../lib/utils"
import type { ChartCategory } from "./chart-types"

export type ChartSkeletonVariant = ChartCategory | "gauge" | "stat"

interface ChartSkeletonProps {
	/** Picks which ghost shape to draw — usually the registry entry's category. */
	variant: ChartSkeletonVariant
	className?: string
}

const STROKE = "var(--muted-foreground)"

/** Wavy ghost path shared by the line + area variants. */
const TREND = "M 2 72 L 20 52 L 38 64 L 56 30 L 74 46 L 98 16"

function GridLines() {
	return (
		<>
			{[28, 52, 76].map((y) => (
				<line
					key={y}
					x1={0}
					y1={y}
					x2={100}
					y2={y}
					stroke={STROKE}
					strokeOpacity={0.12}
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
				/>
			))}
		</>
	)
}

function TrendLine() {
	return (
		<path
			d={TREND}
			fill="none"
			stroke={STROKE}
			strokeOpacity={0.55}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			vectorEffect="non-scaling-stroke"
			pathLength={100}
			className="skeleton-draw"
		/>
	)
}

/** Vertical bars whose heights rise and fall in a staggered wave. */
function Bars({ heights, delay }: { heights: number[]; delay: (i: number) => number }) {
	return (
		<>
			{heights.map((h, i) => (
				<div
					key={i}
					className="flex-1 rounded-[2px] bg-foreground/10 skeleton-bar"
					style={{ height: `${h}%`, animationDelay: `${delay(i)}s` }}
				/>
			))}
		</>
	)
}

const BAR_HEIGHTS = [46, 70, 34, 86, 56, 96, 62]
const HISTOGRAM_HEIGHTS = [14, 28, 46, 68, 86, 96, 84, 64, 42, 26, 13]
const HEATMAP_COLS = 8
const HEATMAP_ROWS = 5

export function ChartSkeleton({ variant, className }: ChartSkeletonProps) {
	return (
		<div
			className={cn(
				"relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-muted/40",
				className,
			)}
			data-slot="chart-skeleton"
			aria-hidden
		>
			{renderVariant(variant)}
		</div>
	)
}

function renderVariant(variant: ChartSkeletonVariant) {
	switch (variant) {
		case "line":
			return (
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					className="h-full w-full p-1"
				>
					<GridLines />
					<TrendLine />
				</svg>
			)

		case "area":
			return (
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					className="h-full w-full p-1"
				>
					<GridLines />
					<path
						d={`${TREND} L 98 100 L 2 100 Z`}
						fill={STROKE}
						fillOpacity={0.1}
					/>
					<TrendLine />
				</svg>
			)

		case "bar":
			return (
				<div className="flex h-full w-full items-end gap-1.5 p-3">
					<Bars heights={BAR_HEIGHTS} delay={(i) => -i * 0.13} />
				</div>
			)

		case "histogram":
			return (
				<div className="flex h-full w-full items-end gap-[3px] p-3">
					<Bars
						heights={HISTOGRAM_HEIGHTS}
						delay={(i) => -Math.abs(i - (HISTOGRAM_HEIGHTS.length - 1) / 2) * 0.11}
					/>
				</div>
			)

		case "heatmap":
			return (
				<div
					className="grid h-full w-full gap-1 p-3"
					style={{
						gridTemplateColumns: `repeat(${HEATMAP_COLS},1fr)`,
						gridTemplateRows: `repeat(${HEATMAP_ROWS},1fr)`,
					}}
				>
					{Array.from({ length: HEATMAP_COLS * HEATMAP_ROWS }, (_, i) => {
						const row = Math.floor(i / HEATMAP_COLS)
						const col = i % HEATMAP_COLS
						return (
							<div
								key={i}
								className="rounded-sm bg-foreground/10 animate-pulse"
								style={{ animationDelay: `${-(row + col) * 0.13}s` }}
							/>
						)
					})}
				</div>
			)

		case "pie":
			return (
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="xMidYMid meet"
					className="h-full max-h-[88%] w-full"
				>
					<circle
						cx={50}
						cy={50}
						r={30}
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.12}
						strokeWidth={16}
					/>
					<g className="skeleton-spin">
						<circle
							cx={50}
							cy={50}
							r={30}
							fill="none"
							stroke={STROKE}
							strokeOpacity={0.45}
							strokeWidth={16}
							strokeLinecap="round"
							pathLength={100}
							strokeDasharray="26 74"
						/>
					</g>
				</svg>
			)

		case "gauge":
			return (
				<svg
					viewBox="0 0 100 100"
					preserveAspectRatio="xMidYMid meet"
					className="h-full w-full"
				>
					<path
						d="M 26 79 A 34 34 0 1 1 74 79"
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.12}
						strokeWidth={9}
						strokeLinecap="round"
					/>
					<path
						d="M 26 79 A 34 34 0 1 1 74 79"
						fill="none"
						stroke={STROKE}
						strokeOpacity={0.55}
						strokeWidth={9}
						strokeLinecap="round"
						pathLength={100}
						className="skeleton-draw"
					/>
					<rect
						x={36}
						y={47}
						width={28}
						height={13}
						rx={3}
						fill={STROKE}
						fillOpacity={0.12}
						className="animate-pulse"
					/>
				</svg>
			)

		case "stat":
			return (
				<div className="flex h-full w-full flex-col items-center justify-center gap-2.5">
					<div className="h-8 w-24 rounded-md bg-foreground/10 animate-pulse" />
					<div
						className="h-3 w-14 rounded bg-foreground/10 animate-pulse"
						style={{ animationDelay: "0.2s" }}
					/>
				</div>
			)
	}
}

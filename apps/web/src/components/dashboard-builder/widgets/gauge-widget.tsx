import { memo, useId } from "react"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface GaugeWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
	onFix?: () => void
}

// Geometry for a 270° segmented gauge drawn in a 240×212 viewBox.
const CX = 120
const CY = 118
const R_OUTER = 88
const R_INNER = 58
const R_RIM = 93
const R_LABEL = 106
const START_ANGLE = 135
const SWEEP = 270
const SEGMENT_COUNT = 56
const RIM_SEGMENT_COUNT = 96
const GAP_RATIO = 0.32
const VALUE_Y = 108

// Perceptual green → yellow → orange → red ramp swept along the arc.
const RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
	[0, 86, 199, 88],
	[0.5, 232, 205, 58],
	[0.74, 242, 142, 44],
	[1, 233, 64, 56],
]

function rampColor(fraction: number): string {
	const x = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
	let lo = RAMP[0]
	let hi = RAMP[RAMP.length - 1]
	for (let i = 0; i < RAMP.length - 1; i++) {
		if (x >= RAMP[i][0] && x <= RAMP[i + 1][0]) {
			lo = RAMP[i]
			hi = RAMP[i + 1]
			break
		}
	}
	const t = (x - lo[0]) / (hi[0] - lo[0] || 1)
	const channel = (index: number) => Math.round(lo[index] + (hi[index] - lo[index]) * t)
	return `rgb(${channel(1)}, ${channel(2)}, ${channel(3)})`
}

function polar(radius: number, degrees: number): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180
	return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) }
}

// A four-point fan blade between two radii across an angular slice.
function bladePoints(startDeg: number, endDeg: number): string {
	const a = polar(R_INNER, startDeg)
	const b = polar(R_OUTER, startDeg)
	const c = polar(R_OUTER, endDeg)
	const d = polar(R_INNER, endDeg)
	return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || typeof value === "object") return null
	const num = typeof value === "number" ? value : Number(value)
	return Number.isFinite(num) ? num : null
}

export const GaugeWidget = memo(function GaugeWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onFix,
}: GaugeWidgetProps) {
	const glowId = useId().replace(/:/g, "")
	const rawValue = dataState.status === "ready" ? dataState.data : undefined
	const value = toNumber(rawValue)

	const min = display.gauge?.min ?? 0
	const max = display.gauge?.max ?? 100
	const span = max - min > 0 ? max - min : 1
	const fraction = value !== null ? Math.min(1, Math.max(0, (value - min) / span)) : 0

	const formattedValue =
		value !== null
			? `${display.prefix ?? ""}${formatValueByUnit(value, display.unit)}${display.suffix ?? ""}`
			: "—"

	const slotAngle = SWEEP / SEGMENT_COUNT
	const gapAngle = slotAngle * GAP_RATIO
	const segments = Array.from({ length: SEGMENT_COUNT }, (_, index) => {
		const slotStart = START_ANGLE + index * slotAngle
		const mid = (index + 0.5) / SEGMENT_COUNT
		const filled = value !== null && mid <= fraction
		return {
			points: bladePoints(slotStart + gapAngle / 2, slotStart + slotAngle - gapAngle / 2),
			filled,
			color: rampColor(mid),
		}
	})

	// Continuous gradient scale line traced just outside the blades.
	const rim = Array.from({ length: RIM_SEGMENT_COUNT }, (_, index) => {
		const from = index / RIM_SEGMENT_COUNT
		const to = (index + 1) / RIM_SEGMENT_COUNT
		return {
			a: polar(R_RIM, START_ANGLE + from * SWEEP),
			b: polar(R_RIM, START_ANGLE + to * SWEEP),
			color: rampColor((from + to) / 2),
		}
	})

	// Rim labels: the range bounds plus each in-range threshold value, rotated
	// to sit tangent to the arc.
	const seen = new Set<number>()
	const labels = [min, ...(display.thresholds ?? []).map((threshold) => threshold.value), max]
		.filter((labelValue) => {
			if (labelValue < min || labelValue > max || seen.has(labelValue)) return false
			seen.add(labelValue)
			return true
		})
		.sort((a, b) => a - b)
		.map((labelValue) => {
			const angle = START_ANGLE + ((labelValue - min) / span) * SWEEP
			const point = polar(R_LABEL, angle)
			let rotation = (angle + 90) % 360
			if (rotation > 90 && rotation < 270) rotation -= 180
			return { value: labelValue, x: point.x, y: point.y, rotation }
		})

	return (
		<WidgetFrame
			title={display.title || "Untitled"}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onFix={onFix}
			contentClassName="flex-1 min-h-0 flex items-center justify-center p-2"
			loadingSkeleton={<ChartSkeleton variant="gauge" />}
		>
			<svg
				viewBox="0 0 240 212"
				preserveAspectRatio="xMidYMid meet"
				className="h-full w-full"
				role="img"
				aria-label={`Gauge: ${formattedValue}`}
			>
				<defs>
					<filter id={`glow-${glowId}`} x="-40%" y="-40%" width="180%" height="180%">
						<feGaussianBlur stdDeviation="3" />
					</filter>
					<radialGradient id={`hole-${glowId}`} cx="0.5" cy="0.46" r="0.6">
						<stop offset="0%" stopColor="var(--muted)" stopOpacity={0.55} />
						<stop offset="100%" stopColor="var(--muted)" stopOpacity={0} />
					</radialGradient>
				</defs>

				{/* Subtle depth in the dial face. */}
				<circle cx={CX} cy={CY} r={R_INNER - 2} fill={`url(#hole-${glowId})`} />

				{/* Bloom underlay for the lit blades. */}
				<g filter={`url(#glow-${glowId})`} opacity={0.7}>
					{segments.map((segment, index) =>
						segment.filled ? (
							<polygon key={index} points={segment.points} fill={segment.color} />
						) : null,
					)}
				</g>

				{/* Fan blades — lit blades carry the color ramp, the rest are dimmed. */}
				{segments.map((segment, index) => (
					<polygon
						key={index}
						points={segment.points}
						fill={segment.filled ? segment.color : "var(--muted-foreground)"}
						fillOpacity={segment.filled ? 1 : 0.22}
					/>
				))}

				{/* Continuous gradient scale line on the outer layer. */}
				{rim.map((segment, index) => (
					<line
						key={`rim-${index}`}
						x1={segment.a.x}
						y1={segment.a.y}
						x2={segment.b.x}
						y2={segment.b.y}
						stroke={segment.color}
						strokeWidth={1.7}
						strokeLinecap="round"
					/>
				))}

				{/* Range + threshold labels, tangent to the rim. */}
				{labels.map((label) => (
					<text
						key={label.value}
						x={label.x}
						y={label.y}
						textAnchor="middle"
						dominantBaseline="central"
						transform={`rotate(${label.rotation} ${label.x} ${label.y})`}
						className="fill-muted-foreground"
						style={{ fontSize: 9 }}
					>
						{formatValueByUnit(label.value, display.unit)}
					</text>
				))}

				{/* Center value. */}
				<text
					x={CX}
					y={VALUE_Y}
					textAnchor="middle"
					dominantBaseline="central"
					className="fill-foreground"
					style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}
				>
					{formattedValue}
				</text>
			</svg>
		</WidgetFrame>
	)
})

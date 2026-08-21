"use client"

import type { CSSProperties } from "react"

import "@/components/dotmatrix-loader.css"

export type MatrixPattern = "diamond" | "full" | "outline" | "rose" | "cross" | "rings"
type DotStyle = "circle" | "square" | "diamond" | "hearts"
export type DotMatrixPhase = "idle" | "collapse" | "hoverRipple" | "loadingRipple"
export type DotMatrixColorPreset =
	| "solid-theme"
	| "solid-mint"
	| "grad-sunset"
	| "grad-ocean"
	| "grad-neon"
	| "grad-aurora"
	| "grad-fire"
	| "grad-prism"

const DOT_MATRIX_COLOR_PRESETS: Record<
	DotMatrixColorPreset,
	{
		fill: string
		glow: string
	}
> = {
	"solid-theme": {
		fill: "var(--color-dot-on)",
		glow: "var(--color-dot-on)",
	},
	"solid-mint": {
		fill: "#34d399",
		glow: "#34d399",
	},
	"grad-sunset": {
		fill: "linear-gradient(135deg, #ff5f6d 0%, #ffc371 52%, #ffe29a 100%)",
		glow: "#ff8b73",
	},
	"grad-ocean": {
		fill: "linear-gradient(140deg, #00c6ff 0%, #0072ff 48%, #4facfe 100%)",
		glow: "#2f8fff",
	},
	"grad-neon": {
		fill: "linear-gradient(145deg, #b4ff39 0%, #39ffb6 46%, #00d4ff 100%)",
		glow: "#59ffc8",
	},
	"grad-aurora": {
		fill: "linear-gradient(145deg, #ff3cac 0%, #784ba0 45%, #2b86c5 100%)",
		glow: "#9c64bf",
	},
	"grad-fire": {
		fill: "linear-gradient(145deg, #ff512f 0%, #dd2476 45%, #ffb347 100%)",
		glow: "#f96a5f",
	},
	"grad-prism": {
		fill: "linear-gradient(145deg, #12c2e9 0%, #c471ed 45%, #f64f59 100%)",
		glow: "#9e7de8",
	},
} satisfies Record<
	DotMatrixColorPreset,
	{
		fill: string
		glow: string
	}
>

function resolveDmxColorTokens(
	color: string,
	colorPreset?: DotMatrixColorPreset,
): {
	resolvedColor: string
	dotFill: string
} {
	if (!colorPreset) {
		return { resolvedColor: color, dotFill: color }
	}

	const preset = DOT_MATRIX_COLOR_PRESETS[colorPreset]
	if (!preset) {
		return { resolvedColor: color, dotFill: color }
	}

	return { resolvedColor: preset.glow, dotFill: preset.fill }
}

export interface DotMatrixCommonProps {
	size?: number
	dotSize?: number
	color?: string
	colorPreset?: DotMatrixColorPreset
	speed?: number
	ariaLabel?: string
	className?: string
	pattern?: MatrixPattern
	muted?: boolean
	/**
	 * Adds a glow on dots from opacity 0.6 (weakest) through 1 (strongest), after remapping.
	 */
	bloom?: boolean
	/** Uniform glow on every active dot (0…1); slightly wider falloff than selective `bloom`. */
	halo?: number
	animated?: boolean
	hoverAnimated?: boolean
	dotClassName?: string
	dotShape?: DotStyle
	opacityBase?: number
	opacityMid?: number
	opacityPeak?: number
	cellPadding?: number
	boxSize?: number
	minSize?: number
}

interface DotAnimationContext {
	index: number
	row: number
	col: number
	distanceFromCenter: number
	angleFromCenter: number
	radiusNormalized: number
	manhattanDistance: number
	phase: DotMatrixPhase
	isActive: boolean
	reducedMotion: boolean
}

interface DotAnimationState {
	className?: string
	style?: CSSProperties
}

export type DotAnimationResolver = (ctx: DotAnimationContext) => DotAnimationState

function cx(...values: Array<string | undefined | null | false>): string {
	return values.filter(Boolean).join(" ")
}

const MATRIX_SIZE = 5
const CENTER = Math.floor(MATRIX_SIZE / 2)
const RANGE = Array.from({ length: MATRIX_SIZE }, (_, index) => index)
const MAX_RADIUS = Math.hypot(CENTER, CENTER)

const FULL_INDEXES = RANGE.flatMap((row) => RANGE.map((col) => rowMajorIndex(row, col)))

const DIAMOND_INDEXES = FULL_INDEXES.filter((index) => {
	const { row, col } = indexToCoord(index)
	return Math.abs(row - CENTER) + Math.abs(col - CENTER) <= 2
})

const OUTLINE_INDEXES = FULL_INDEXES.filter((index) => {
	const { row, col } = indexToCoord(index)
	return row === 0 || row === MATRIX_SIZE - 1 || col === 0 || col === MATRIX_SIZE - 1
})

const CROSS_INDEXES = FULL_INDEXES.filter((index) => {
	const { row, col } = indexToCoord(index)
	return row === CENTER || col === CENTER
})

const RINGS_INDEXES = FULL_INDEXES.filter((index) => {
	const { row, col } = indexToCoord(index)
	const radius = Math.hypot(row - CENTER, col - CENTER)
	return Math.round(radius) === 1 || Math.round(radius) === 2
})

const ROSE_INDEXES = FULL_INDEXES.filter((index) => {
	const { row, col } = indexToCoord(index)
	const dx = col - CENTER
	const dy = row - CENTER
	const angle = Math.atan2(dy, dx)
	const radius = Math.hypot(dx, dy)
	const rose = Math.abs(Math.sin(3 * angle))
	return rose > 0.6 && radius >= 1
})

const PATTERN_INDEXES: Record<MatrixPattern, number[]> = {
	diamond: DIAMOND_INDEXES,
	full: FULL_INDEXES,
	outline: OUTLINE_INDEXES,
	rose: ROSE_INDEXES,
	cross: CROSS_INDEXES,
	rings: RINGS_INDEXES,
} satisfies Record<MatrixPattern, number[]>

function getPatternIndexes(pattern: MatrixPattern = "diamond"): number[] {
	return PATTERN_INDEXES[pattern]
}

function rowMajorIndex(row: number, col: number): number {
	return row * MATRIX_SIZE + col
}

function indexToCoord(index: number): { row: number; col: number } {
	return {
		row: Math.floor(index / MATRIX_SIZE),
		col: index % MATRIX_SIZE,
	}
}

function distanceFromCenter(index: number): number {
	const { row, col } = indexToCoord(index)
	return Math.hypot(row - CENTER, col - CENTER)
}

function polarAngle(index: number): number {
	const { row, col } = indexToCoord(index)
	return Math.atan2(row - CENTER, col - CENTER)
}

function normalizedRadius(index: number): number {
	const { row, col } = indexToCoord(index)
	return Math.hypot(row - CENTER, col - CENTER) / MAX_RADIUS
}

function manhattanDistance(index: number): number {
	const { row, col } = indexToCoord(index)
	return Math.abs(row - CENTER) + Math.abs(col - CENTER)
}

const N = MATRIX_SIZE
const CELLS = N * N

function buildOuterRingClockwiseOrderToIndexMap(): number[] {
	const order = new Array<number>(CELLS).fill(-1)
	const coords: Array<[number, number]> = [
		[0, 0],
		[0, 1],
		[0, 2],
		[0, 3],
		[0, 4],
		[1, 4],
		[2, 4],
		[3, 4],
		[4, 4],
		[4, 3],
		[4, 2],
		[4, 1],
		[4, 0],
		[3, 0],
		[2, 0],
		[1, 0],
	]

	for (let t = 0; t < coords.length; t += 1) {
		const [row, col] = coords[t]!
		order[rowMajorIndex(row, col)] = t
	}

	return order
}

function buildMiddleRingAntiClockwiseOrderToIndexMap(): number[] {
	const order = new Array<number>(CELLS).fill(-1)
	const coords: Array<[number, number]> = [
		[1, 1],
		[2, 1],
		[3, 1],
		[3, 2],
		[3, 3],
		[2, 3],
		[1, 3],
		[1, 2],
	]

	for (let t = 0; t < coords.length; t += 1) {
		const [row, col] = coords[t]!
		order[rowMajorIndex(row, col)] = t
	}

	return order
}

const OUTER_RING_CLOCKWISE_ORDER: readonly number[] = buildOuterRingClockwiseOrderToIndexMap()
const MIDDLE_RING_ANTI_CLOCKWISE_ORDER: readonly number[] = buildMiddleRingAntiClockwiseOrderToIndexMap()

export function outerRingClockwiseOrderValue(index: number): number {
	return OUTER_RING_CLOCKWISE_ORDER[index]!
}

export function outerRingClockwiseNormFromIndex(index: number): number {
	const order = outerRingClockwiseOrderValue(index)
	return order >= 0 ? order / 15 : 0
}

export function middleRingAntiClockwiseOrderValue(index: number): number {
	return MIDDLE_RING_ANTI_CLOCKWISE_ORDER[index]!
}

export function middleRingAntiClockwiseNormFromIndex(index: number): number {
	const order = middleRingAntiClockwiseOrderValue(index)
	return order >= 0 ? order / 7 : 0
}

const SOURCE_BASE_OPACITY = 0.08
const SOURCE_MID_OPACITY = 0.34
const SOURCE_PEAK_OPACITY = 0.94

function lerpDmx(start: number, end: number, progress: number): number {
	return start + (end - start) * progress
}

function normalizeProgressDmx(value: number, start: number, end: number): number {
	const span = end - start
	if (Math.abs(span) < Number.EPSILON) {
		return 0
	}
	return Math.min(1, Math.max(0, (value - start) / span))
}

function coerceOpacityDmx(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) {
		return undefined
	}
	return Math.min(1, Math.max(0, value))
}

function remapOpacityToTriplet(
	opacity: number,
	opacityBase: number | undefined,
	opacityMid: number | undefined,
	opacityPeak: number | undefined,
): number {
	if (!Number.isFinite(opacity)) {
		return opacity
	}

	const hasOverrides = opacityBase !== undefined || opacityMid !== undefined || opacityPeak !== undefined
	const safeOpacity = Math.min(1, Math.max(0, opacity))
	if (!hasOverrides) {
		return safeOpacity
	}

	const targetBase = coerceOpacityDmx(opacityBase) ?? SOURCE_BASE_OPACITY
	const targetMid = coerceOpacityDmx(opacityMid) ?? SOURCE_MID_OPACITY
	const targetPeak = coerceOpacityDmx(opacityPeak) ?? SOURCE_PEAK_OPACITY

	if (safeOpacity <= SOURCE_BASE_OPACITY) {
		const progress = normalizeProgressDmx(safeOpacity, 0, SOURCE_BASE_OPACITY)
		return Math.min(1, Math.max(0, lerpDmx(0, targetBase, progress)))
	}

	if (safeOpacity <= SOURCE_MID_OPACITY) {
		const progress = normalizeProgressDmx(safeOpacity, SOURCE_BASE_OPACITY, SOURCE_MID_OPACITY)
		return Math.min(1, Math.max(0, lerpDmx(targetBase, targetMid, progress)))
	}

	if (safeOpacity <= SOURCE_PEAK_OPACITY) {
		const progress = normalizeProgressDmx(safeOpacity, SOURCE_MID_OPACITY, SOURCE_PEAK_OPACITY)
		return Math.min(1, Math.max(0, lerpDmx(targetMid, targetPeak, progress)))
	}

	const progress = normalizeProgressDmx(safeOpacity, SOURCE_PEAK_OPACITY, 1)
	return Math.min(1, Math.max(0, lerpDmx(targetPeak, 1, progress)))
}

/** Remapped opacity where bloom begins (weakest glow); scales linearly to full bloom at 1. */
const DMX_BLOOM_OPACITY_MIN = 0.6

function opacityToBloomLevel(remappedOpacity: number): number {
	return Math.max(0, Math.min(1, (remappedOpacity - DMX_BLOOM_OPACITY_MIN) / (1 - DMX_BLOOM_OPACITY_MIN)))
}

function remappedOpacityQualifiesForBloom(remappedOpacity: number): boolean {
	return remappedOpacity >= DMX_BLOOM_OPACITY_MIN
}

function clampHalo(value: number | undefined): number {
	if (value == null || !Number.isFinite(value)) {
		return 0
	}
	return Math.min(1, Math.max(0, value))
}

function dmxBloomRootActive(bloom: boolean, halo: number | undefined): boolean {
	return bloom || clampHalo(halo) > 0
}

/** Root class when `halo` > 0 — CSS widens drop-shadow falloff for a softer, more diffuse glow. */
function dmxBloomHaloSpreadClass(halo: number | undefined): "dmx-bloom-halo" | false {
	return clampHalo(halo) > 0 ? "dmx-bloom-halo" : false
}

/**
 * Bloom level and dot class for one cell. `curveOpacity` is the loader’s logical opacity **before**
 * `remapOpacityToTriplet` (same as `bloom` uses today).
 */
function dmxDotBloomParts(
	isActive: boolean,
	curveOpacity: number,
	bloom: boolean,
	halo: number | undefined,
	ob: number | undefined,
	om: number | undefined,
	op: number | undefined,
): { level: number; bloomDot: boolean } {
	const haloN = clampHalo(halo)
	if (!isActive) {
		return { level: 0, bloomDot: false }
	}
	const remapped = remapOpacityToTriplet(curveOpacity, ob, om, op)
	const fromBloom = bloom ? opacityToBloomLevel(remapped) : 0
	return {
		level: fromBloom,
		bloomDot: haloN > 0 || (bloom && remappedOpacityQualifiesForBloom(remapped)),
	}
}

function getMatrix5Layout(
	size: number,
	dotSize: number,
	cellPadding?: number,
): { gap: number; matrixSpan: number } {
	const n = MATRIX_SIZE
	if (cellPadding != null) {
		const g = Math.max(0, cellPadding)
		const matrixSpan = dotSize * n + g * (n - 1)
		return { gap: g, matrixSpan }
	}
	const g = Math.max(1, Math.floor((size - dotSize * n) / (n - 1)))
	return { gap: g, matrixSpan: size }
}

function resolveDmxBoxOuterDim(options: { boxSize?: number; minSize?: number } | null | undefined): {
	outerDim: number
	useWrapper: boolean
} {
	const b = options?.boxSize
	const hasBox = b != null && b > 0 && Number.isFinite(b)
	if (!hasBox) {
		return { outerDim: 0, useWrapper: false }
	}
	const m = options?.minSize
	if (m != null && m > 0 && Number.isFinite(m)) {
		return { outerDim: Math.max(b, m), useWrapper: true }
	}
	return { outerDim: b, useWrapper: true }
}

function clamp01Dmx(n: number | undefined) {
	if (n == null) {
		return
	}
	if (!Number.isFinite(n)) {
		return
	}
	return Math.min(1, Math.max(0, n))
}

interface DotMatrixBaseProps extends DotMatrixCommonProps {
	phase: DotMatrixPhase
	reducedMotion?: boolean
	onMouseEnter?: () => void
	onMouseLeave?: () => void
	animationResolver?: DotAnimationResolver
}

export function DotMatrixBase({
	size = 24,
	dotSize = 3,
	color = "currentColor",
	colorPreset,
	speed = 1,
	ariaLabel = "Loading",
	className,
	pattern = "diamond",
	dotShape: dotStyle = "circle",
	muted = false,
	bloom = false,
	halo = 0,
	dotClassName,
	phase,
	reducedMotion = false,
	onMouseEnter,
	onMouseLeave,
	animationResolver,
	opacityBase,
	opacityMid,
	opacityPeak,
	cellPadding,
	boxSize,
	minSize,
}: DotMatrixBaseProps) {
	const patternIndexes = new Set(getPatternIndexes(pattern))
	const safeSpeed = speed > 0 ? speed : 1
	const speedScale = 1 / safeSpeed
	const { gap, matrixSpan } = getMatrix5Layout(size, dotSize, cellPadding)
	const { outerDim, useWrapper } = resolveDmxBoxOuterDim({ boxSize, minSize })
	const scale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1
	const center = Math.floor(MATRIX_SIZE / 2)
	const ob = clamp01Dmx(opacityBase)
	const om = clamp01Dmx(opacityMid)
	const op = clamp01Dmx(opacityPeak)
	const unit = dotSize + gap
	const { resolvedColor, dotFill } = resolveDmxColorTokens(color, colorPreset)

	// SAFETY: React's CSSProperties omits custom properties even though React forwards these --dmx-* values.
	const dmxVarStyle = {
		width: matrixSpan,
		height: matrixSpan,
		"--dmx-speed": speedScale,
		["--dmx-dot-size" as const]: `${dotSize}px`,
		["--dmx-halo-level" as const]: halo,
		["--dmx-dot-fill" as const]: dotFill,
		color: resolvedColor,
		...(ob !== undefined ? { ["--dmx-opacity-base" as const]: ob } : undefined),
		...(om !== undefined ? { ["--dmx-opacity-mid" as const]: om } : undefined),
		...(op !== undefined ? { ["--dmx-opacity-peak" as const]: op } : undefined),
		...(useWrapper
			? {
					transform: `scale(${scale})`,
					transformOrigin: "center center" as const,
				}
			: { minWidth: minSize, minHeight: minSize }),
	} as unknown as CSSProperties

	const dots = Array.from({ length: MATRIX_SIZE * MATRIX_SIZE }).map((_, index) => {
		const { row, col } = indexToCoord(index)
		const isActive = patternIndexes.has(index)
		const distance = distanceFromCenter(index)
		const angle = polarAngle(index)
		const radiusNormalizedValue = normalizedRadius(index)
		const manhattan = manhattanDistance(index)
		const deltaX = (col - center) * unit
		const deltaY = (row - center) * unit

		const animationState = animationResolver
			? animationResolver({
					index,
					row,
					col,
					distanceFromCenter: distance,
					angleFromCenter: angle,
					radiusNormalized: radiusNormalizedValue,
					manhattanDistance: manhattan,
					phase,
					isActive,
					reducedMotion,
				})
			: {}

		const resolvedAnimationStyle = animationState.style ? { ...animationState.style } : undefined
		let isBloomDot = false
		let stylePatch: CSSProperties | undefined = resolvedAnimationStyle

		if (isActive) {
			const rawOpacity = stylePatch?.opacity
			if (stylePatch != null && typeof rawOpacity === "number") {
				const remappedOpacity = remapOpacityToTriplet(rawOpacity, ob, om, op)
				stylePatch = { ...stylePatch, opacity: remappedOpacity }
				const parts = dmxDotBloomParts(true, rawOpacity, bloom, halo, ob, om, op)
				;(stylePatch as CSSProperties & { "--dmx-bloom-level"?: number })["--dmx-bloom-level"] =
					parts.level
				isBloomDot = parts.bloomDot
			} else {
				const parts = dmxDotBloomParts(true, 0, bloom, halo, ob, om, op)
				if (parts.level > 0) {
					stylePatch = {
						...stylePatch,
						["--dmx-bloom-level" as const]: parts.level,
					} as CSSProperties & { "--dmx-bloom-level"?: number }
				}
				isBloomDot = parts.bloomDot
			}
		}

		const dotStyle = {
			width: dotSize,
			height: dotSize,
			"--dmx-distance": distance,
			"--dmx-row": row,
			"--dmx-col": col,
			"--dmx-x": `${deltaX}px`,
			"--dmx-y": `${deltaY}px`,
			"--dmx-angle": angle,
			"--dmx-radius": radiusNormalizedValue,
			"--dmx-manhattan": manhattan,
			...stylePatch,
			...(!isActive
				? {
						opacity: 0,
						visibility: "hidden" as const,
						pointerEvents: "none" as const,
						animation: "none",
					}
				: undefined),
		} as CSSProperties

		return (
			<span
				key={index}
				aria-hidden="true"
				className={cx(
					"dmx-dot",
					!isActive && "dmx-inactive",
					isBloomDot && "dmx-bloom-dot",
					dotClassName,
					animationState.className,
				)}
				style={dotStyle}
			/>
		)
	})

	const matrix = (
		<div
			className={cx(
				"dmx-root",
				`dmx-dot-shape-${dotStyle}`,
				muted && "dmx-muted",
				dmxBloomRootActive(bloom, halo) && "dmx-bloom",
				dmxBloomHaloSpreadClass(halo),
				!useWrapper && className,
			)}
			style={dmxVarStyle}
		>
			<div className="dmx-grid" style={{ gap }}>
				{dots}
			</div>
		</div>
	)

	if (useWrapper) {
		return (
			<div
				role="status"
				aria-live="polite"
				aria-label={ariaLabel}
				className={className}
				style={{
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: outerDim,
					height: outerDim,
					minWidth: minSize,
					minHeight: minSize,
					overflow: "hidden",
				}}
				onMouseEnter={onMouseEnter}
				onMouseLeave={onMouseLeave}
			>
				{matrix}
			</div>
		)
	}

	return (
		<div
			role="status"
			aria-live="polite"
			aria-label={ariaLabel}
			className={cx(
				"dmx-root",
				`dmx-dot-shape-${dotStyle}`,
				muted && "dmx-muted",
				dmxBloomRootActive(bloom, halo) && "dmx-bloom",
				dmxBloomHaloSpreadClass(halo),
				className,
			)}
			style={dmxVarStyle}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
		>
			<div className="dmx-grid" style={{ gap }}>
				{dots}
			</div>
		</div>
	)
}

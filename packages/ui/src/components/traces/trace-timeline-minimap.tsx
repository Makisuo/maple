import * as React from "react"
import type { SpanNode } from "../../lib/types"
import type { ViewportState } from "./trace-timeline-types"
import { MINIMAP_HEIGHT } from "./trace-timeline-types"
import { formatDuration } from "../../lib/format"
import { getValueHue } from "../../lib/colors"
import { resolveColorValue, isStatusCodePreset, type ColorByField } from "./color-by"

interface TraceTimelineMinimapProps {
	rootSpans: SpanNode[]
	traceStartMs: number
	traceEndMs: number
	colorBy: ColorByField
	viewport: ViewportState
	onViewportChange: (viewport: ViewportState) => void
}

interface MinimapSpan {
	spanId: string
	depth: number
	leftPercent: number
	widthPercent: number
	bgColor: string
	isError: boolean
}

const NEUTRAL_MINIMAP_BG = "oklch(0.50 0.02 0)"
/** Errors pop in the minimap so a trace-scale error scan works (Honeycomb pattern). */
const ERROR_MINIMAP_BG = "oklch(0.62 0.22 25)"
/** Movement (px) before a press outside the viewport rect becomes a reframe drag instead of a jump. */
const REFRAME_THRESHOLD_PX = 3

function collectMinimapSpans(
	rootSpans: SpanNode[],
	traceStartMs: number,
	traceDurationMs: number,
	colorBy: ColorByField,
): { spans: MinimapSpan[]; maxDepth: number } {
	const spans: MinimapSpan[] = []
	let maxDepth = 0
	const statusPreset = isStatusCodePreset(colorBy)

	function visit(node: SpanNode) {
		const startMs = new Date(node.startTime).getTime()
		// traceDurationMs spans the full extent of the trace (max end − min start), so every
		// span maps into 0–100% — no skewed span flies off the minimap.
		const leftPercent = ((startMs - traceStartMs) / traceDurationMs) * 100
		const widthPercent = (node.durationMs / traceDurationMs) * 100
		maxDepth = Math.max(maxDepth, node.depth)

		const isError = node.statusCode === "Error"
		let bgColor: string
		if (isError && !statusPreset) {
			bgColor = ERROR_MINIMAP_BG
		} else {
			const value = resolveColorValue(node, colorBy)
			const hue = getValueHue(value)
			bgColor = hue === null ? NEUTRAL_MINIMAP_BG : `oklch(0.50 0.14 ${hue})`
		}

		const clampedLeft = Math.max(0, leftPercent)
		spans.push({
			spanId: node.spanId,
			depth: node.depth,
			leftPercent: clampedLeft,
			widthPercent: Math.min(widthPercent, 100 - clampedLeft),
			bgColor,
			isError,
		})

		node.children.forEach(visit)
	}

	rootSpans.forEach(visit)
	// Errors last → painted on top of same-position siblings.
	spans.sort((a, b) => Number(a.isError) - Number(b.isError))
	return { spans, maxDepth }
}

export function TraceTimelineMinimap({
	rootSpans,
	traceStartMs,
	traceEndMs,
	colorBy,
	viewport,
	onViewportChange,
}: TraceTimelineMinimapProps) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const guideRef = React.useRef<HTMLDivElement>(null)
	const dragRef = React.useRef<{
		type: "pan" | "resize-left" | "resize-right" | "reframe"
		startX: number
		moved: boolean
		startViewport: ViewportState
	} | null>(null)
	/** Live reframe preview, in minimap % — anchor and cursor ends, unordered. */
	const [reframePreview, setReframePreview] = React.useState<{ a: number; b: number } | null>(null)

	const traceDuration = traceEndMs - traceStartMs

	const { spans, maxDepth } = React.useMemo(
		() => collectMinimapSpans(rootSpans, traceStartMs, traceDuration, colorBy),
		[rootSpans, traceStartMs, traceDuration, colorBy],
	)

	// Fit every depth level inside the strip: deep traces compress the row pitch evenly
	// instead of piling everything past a fixed depth onto the bottom row.
	const pitch = Math.max(1, Math.min(4, Math.floor((MINIMAP_HEIGHT - 4) / (maxDepth + 1))))
	const rowH = Math.max(1, pitch - 1)

	// Viewport rectangle position
	const vpLeftPercent = ((viewport.startMs - traceStartMs) / traceDuration) * 100
	const vpWidthPercent = ((viewport.endMs - viewport.startMs) / traceDuration) * 100

	const pctFromEvent = React.useCallback((clientX: number) => {
		const rect = containerRef.current?.getBoundingClientRect()
		if (!rect || rect.width === 0) return 0
		return ((clientX - rect.left) / rect.width) * 100
	}, [])

	const handleMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			if (!containerRef.current) return
			const clickPercent = pctFromEvent(e.clientX)

			// Check if clicking on viewport edges (resize) or inside viewport (pan)
			const edgeThreshold = 2 // percent
			if (
				clickPercent >= vpLeftPercent - edgeThreshold &&
				clickPercent <= vpLeftPercent + edgeThreshold
			) {
				dragRef.current = {
					type: "resize-left",
					startX: e.clientX,
					moved: false,
					startViewport: { ...viewport },
				}
			} else if (
				clickPercent >= vpLeftPercent + vpWidthPercent - edgeThreshold &&
				clickPercent <= vpLeftPercent + vpWidthPercent + edgeThreshold
			) {
				dragRef.current = {
					type: "resize-right",
					startX: e.clientX,
					moved: false,
					startViewport: { ...viewport },
				}
			} else if (clickPercent >= vpLeftPercent && clickPercent <= vpLeftPercent + vpWidthPercent) {
				dragRef.current = {
					type: "pan",
					startX: e.clientX,
					moved: false,
					startViewport: { ...viewport },
				}
			} else {
				// Outside the viewport rect: a drag draws a new range (Jaeger's reframe);
				// a plain click (no movement) jumps the viewport center — resolved on mouseup.
				dragRef.current = {
					type: "reframe",
					startX: e.clientX,
					moved: false,
					startViewport: { ...viewport },
				}
			}

			e.preventDefault()
		},
		[viewport, vpLeftPercent, vpWidthPercent, pctFromEvent],
	)

	React.useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			const d = dragRef.current
			if (!d || !containerRef.current) return
			const rect = containerRef.current.getBoundingClientRect()
			const deltaPercent = ((e.clientX - d.startX) / rect.width) * 100
			const deltaMs = (deltaPercent / 100) * traceDuration
			const sv = d.startViewport

			switch (d.type) {
				case "pan":
					onViewportChange({
						startMs: sv.startMs + deltaMs,
						endMs: sv.endMs + deltaMs,
					})
					break
				case "resize-left":
					onViewportChange({
						startMs: Math.min(sv.startMs + deltaMs, sv.endMs - traceDuration * 0.01),
						endMs: sv.endMs,
					})
					break
				case "resize-right":
					onViewportChange({
						startMs: sv.startMs,
						endMs: Math.max(sv.endMs + deltaMs, sv.startMs + traceDuration * 0.01),
					})
					break
				case "reframe": {
					if (!d.moved && Math.abs(e.clientX - d.startX) <= REFRAME_THRESHOLD_PX) return
					d.moved = true
					const a = ((d.startX - rect.left) / rect.width) * 100
					const b = ((e.clientX - rect.left) / rect.width) * 100
					setReframePreview({ a, b })
					break
				}
			}
		}

		const handleMouseUp = (e: MouseEvent) => {
			const d = dragRef.current
			dragRef.current = null
			if (!d) return
			if (d.type !== "reframe") return
			setReframePreview(null)
			const rect = containerRef.current?.getBoundingClientRect()
			if (!rect || rect.width === 0) return
			if (d.moved) {
				// Commit the previewed range (either drag direction).
				const aPct = ((d.startX - rect.left) / rect.width) * 100
				const bPct = ((e.clientX - rect.left) / rect.width) * 100
				const lo = Math.min(aPct, bPct)
				const hi = Math.max(aPct, bPct)
				onViewportChange({
					startMs: traceStartMs + (lo / 100) * traceDuration,
					endMs: traceStartMs + (hi / 100) * traceDuration,
				})
			} else {
				// Plain click: jump viewport center to the clicked position.
				const clickPercent = ((e.clientX - rect.left) / rect.width) * 100
				const clickMs = traceStartMs + (clickPercent / 100) * traceDuration
				const vpDuration = d.startViewport.endMs - d.startViewport.startMs
				onViewportChange({
					startMs: clickMs - vpDuration / 2,
					endMs: clickMs + vpDuration / 2,
				})
			}
		}

		window.addEventListener("mousemove", handleMouseMove)
		window.addEventListener("mouseup", handleMouseUp)
		return () => {
			window.removeEventListener("mousemove", handleMouseMove)
			window.removeEventListener("mouseup", handleMouseUp)
		}
	}, [traceDuration, traceStartMs, onViewportChange])

	// Hover guide: vertical line + time readout, written imperatively (no re-render per pixel).
	const handleHoverMove = React.useCallback(
		(e: React.MouseEvent) => {
			const node = guideRef.current
			const rect = containerRef.current?.getBoundingClientRect()
			if (!node || !rect || rect.width === 0) return
			if (dragRef.current) {
				node.style.display = "none"
				return
			}
			const x = e.clientX - rect.left
			node.style.display = "block"
			node.style.transform = `translateX(${x}px)`
			const label = node.firstElementChild as HTMLElement | null
			if (label) {
				label.textContent = `+${formatDuration((x / rect.width) * traceDuration)}`
				label.style.transform = x > rect.width - 70 ? "translateX(calc(-100% - 5px))" : "translateX(5px)"
			}
		},
		[traceDuration],
	)

	const handleHoverLeave = React.useCallback(() => {
		if (guideRef.current) guideRef.current.style.display = "none"
	}, [])

	const handleDoubleClick = React.useCallback(() => {
		onViewportChange({ startMs: traceStartMs, endMs: traceEndMs })
	}, [onViewportChange, traceStartMs, traceEndMs])

	const previewLo = reframePreview ? Math.min(reframePreview.a, reframePreview.b) : null
	const previewHi = reframePreview ? Math.max(reframePreview.a, reframePreview.b) : null

	return (
		<div
			ref={containerRef}
			className="relative border-b border-border bg-muted/10 cursor-crosshair select-none"
			style={{ height: MINIMAP_HEIGHT }}
			onMouseDown={handleMouseDown}
			onMouseMove={handleHoverMove}
			onMouseLeave={handleHoverLeave}
			onDoubleClick={handleDoubleClick}
			title="Drag to select a range · click to jump · double-click to fit"
		>
			{/* Minimap bars */}
			<div className="absolute inset-x-0 inset-y-0 px-0" style={{ paddingTop: 2, paddingBottom: 2 }}>
				{spans.map((s) => (
					<div
						key={s.spanId}
						className="absolute"
						style={{
							top: Math.min(2 + s.depth * pitch, MINIMAP_HEIGHT - rowH - 2),
							left: `${s.leftPercent}%`,
							width: `${Math.max(s.widthPercent, 0.2)}%`,
							height: rowH,
							backgroundColor: s.bgColor,
						}}
					/>
				))}
			</div>

			{/* Dimmed areas outside viewport */}
			<div
				className="absolute inset-y-0 bg-background/60"
				style={{ left: 0, width: `${Math.max(0, vpLeftPercent)}%` }}
			/>
			<div
				className="absolute inset-y-0 bg-background/60"
				style={{ left: `${vpLeftPercent + vpWidthPercent}%`, right: 0 }}
			/>

			{/* Reframe preview (drag-in-progress) */}
			{previewLo !== null && previewHi !== null && (
				<div
					className="absolute inset-y-0 border-x border-primary/70 bg-primary/15 pointer-events-none"
					style={{ left: `${previewLo}%`, width: `${previewHi - previewLo}%` }}
				/>
			)}

			{/* Hover guide: line + time readout (imperative) */}
			<div
				ref={guideRef}
				className="pointer-events-none absolute inset-y-0 left-0 w-px bg-foreground/40"
				style={{ display: "none" }}
			>
				<span className="absolute top-0 whitespace-nowrap bg-background/90 px-1 font-mono text-[9px] leading-3 text-muted-foreground" />
			</div>

			{/* Viewport indicator */}
			<div
				className="absolute inset-y-0 border-x-2 border-primary/60 cursor-grab active:cursor-grabbing"
				style={{
					left: `${vpLeftPercent}%`,
					width: `${Math.max(vpWidthPercent, 1)}%`,
				}}
			>
				{/* Resize affordances — hit detection lives in handleMouseDown; these only set the cursor. */}
				<div className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize" />
				<div className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize" />
			</div>
		</div>
	)
}

import { createMark } from "@tanstack/charts"
import type { ChartMark, ChartTick, SceneRule } from "@tanstack/charts"

/**
 * The dash the Recharts `CartesianGrid` painted — `vertical={false}`,
 * `strokeDasharray="3 3"`. Rules carry the renderer's default butt cap, so the
 * numbers are the widths that actually paint; `roundCapDasharray` is for `lineY`
 * and `areaY` only.
 */
const GRID_DASHARRAY = "3 3"

/**
 * The library's own grid paint (`dist/scene.js:815-823` at 0.16.0), kept verbatim so
 * swapping the built-in grid for this mark changes the dash and nothing else.
 */
const GRID_STROKE_OPACITY = 0.11

export interface DashedGridYOptions {
	id?: string
	/** Widths in scene pixels — dash, then gap. */
	dasharray?: string
	strokeOpacity?: number
}

/**
 * Horizontal grid lines at the y axis' ticks, dashed.
 *
 * `ChartAxisOptions.grid` is a `boolean` and `ChartTheme` carries only a grid
 * COLOUR, so the built-in grid is solid and there is no option anywhere that
 * dashes it. Under the SVG renderer a `.ts-chart__grid` CSS rule would do it,
 * but `PlotFrame` defaults to canvas, whose scene nodes are not DOM descendants
 * and cannot be reached by a selector — so the dash has to come from the scene
 * itself. `createMark` is the documented seam for that.
 *
 * Emit it as the FIRST entry of `marks` and leave `grid` off the axis: marks
 * paint in declaration order, so anywhere later would draw the grid over the
 * data. It declares no channels and no interaction points, so it neither widens
 * a domain nor competes for focus.
 */
export function dashedGridY(options: DashedGridYOptions = {}): ChartMark<never, never, never> {
	return createMark<never, never, never>(({ markIndex }) => {
		const id = options.id ?? `dashed-grid-y-${markIndex}`
		return {
			id,
			channels: {},
			render: ({ chart, scales, theme }) => {
				const scale = scales.y
				// A chart whose y scale resolved without ticks (an empty result set)
				// has no grid to draw, and `scales.y` itself is absent from a chart
				// that declares no y axis.
				const ticks: readonly ChartTick[] = scale?.ticks ?? []
				const children: SceneRule[] = ticks.map((tick) => ({
					kind: "rule",
					key: `${id}:${String(tick.value)}`,
					x1: chart.x,
					x2: chart.x + chart.width,
					y1: tick.position,
					y2: tick.position,
				}))
				return {
					nodes: [
						{
							kind: "group",
							key: id,
							className: "ts-chart__grid",
							ariaHidden: true,
							children,
							style: {
								stroke: theme.grid,
								strokeOpacity: options.strokeOpacity ?? GRID_STROKE_OPACITY,
								strokeWidth: 1,
								strokeDasharray: options.dasharray ?? GRID_DASHARRAY,
							},
						},
					],
				}
			},
		}
	})
}

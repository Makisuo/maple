// The session page's shared color vocabulary: one token per kind of work, read
// identically by the header's breakdown bar, the waterfall's dots and bars and
// the flow view's nodes. The tokens are the app's existing chart tokens rather
// than new ones, and time-to-first-token is a lighter value of the inference
// token rather than a fifth hue — chart-5 and chart-2 are two near-identical
// cyans in the light palette (ΔL 0.04, Δh 25°).

import { DotsIcon, FaceRobotIcon, GearIcon, PixelSparkleIcon, type IconComponent } from "@/components/icons"

import type { AiSpanCategory } from "@/lib/agent-sessions/session-turns"
import type { OccupancyKind } from "@/lib/agent-sessions/session-summary"

// Idle and unaccounted are the absence of work, so they get the neutral rather
// than a hue; unaccounted is denser because it is usually a percent or two of
// the bar and washes out at that width.
const NO_WORK_FILL = "bg-muted-foreground/40"
const UNACCOUNTED_FILL = "bg-muted-foreground/70"

/** Bar and dot background, per span category. */
export const CATEGORY_FILL = {
	agent: "bg-chart-1",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	other: NO_WORK_FILL,
} satisfies Record<AiSpanCategory, string>

/** Flow node glyph, per span category: the kind of work reads by shape, with
 *  the hue as reinforcement — the same rule `investigations/flow` follows.
 *  `other` never earns a flow node; the entry exists so the record is total. */
export const CATEGORY_ICON = {
	agent: FaceRobotIcon,
	inference: PixelSparkleIcon,
	tool: GearIcon,
	other: DotsIcon,
} satisfies Record<AiSpanCategory, IconComponent>

/** The same chart tokens as `CATEGORY_FILL`, as text color for the glyphs. */
export const CATEGORY_TEXT = {
	agent: "text-chart-1",
	inference: "text-chart-2",
	tool: "text-chart-4",
	other: "text-muted-foreground",
} satisfies Record<AiSpanCategory, string>

/** Segment background in the header's occupancy bar. */
export const OCCUPANCY_FILL = {
	idle: NO_WORK_FILL,
	ttft: "bg-chart-2/45",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	unaccounted: UNACCOUNTED_FILL,
} satisfies Record<OccupancyKind, string>

/** The same vocabulary at 6px, where the 45% ttft fill washes out. */
export const OCCUPANCY_DOT_FILL = {
	idle: NO_WORK_FILL,
	ttft: "bg-chart-2/70",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	unaccounted: UNACCOUNTED_FILL,
} satisfies Record<OccupancyKind, string>

/** Legend text for an occupancy segment. */
export const OCCUPANCY_LABEL = {
	idle: "Idle",
	ttft: "Time to first token",
	inference: "Inference",
	tool: "Tool execution",
	unaccounted: "Unaccounted",
} satisfies Record<OccupancyKind, string>

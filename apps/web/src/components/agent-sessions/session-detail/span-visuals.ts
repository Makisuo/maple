// The session page's shared visual vocabulary: one color per kind of work,
// used by the header's breakdown bar, the waterfall's dots and bars, and the
// flow view's nodes. Reading the same color as the same thing across all three
// is the whole reason it lives in one place.
//
// These map onto the app's existing chart tokens rather than new ones — agent
// work is the product's own amber, inference the blue that already means
// "outbound call", tools the teal, and time-to-first-token the purple the charts
// use for a leading segment.

import type { SpanCategory } from "@/lib/agent-sessions/session-turns"
import type { OccupancyKind } from "@/lib/agent-sessions/session-summary"

/** Background for a bar or a dot. */
export const CATEGORY_FILL = {
	agent: "bg-chart-1",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	other: "bg-muted-foreground/40",
} satisfies Record<SpanCategory, string>

export const CATEGORY_LABEL = {
	agent: "agent",
	inference: "inference",
	tool: "tool",
	other: "other",
} satisfies Record<SpanCategory, string>

export const OCCUPANCY_FILL = {
	// Idle is the absence of work, so it gets a neutral surface rather than a
	// hue: a colored idle segment reads as a category of work at a glance.
	idle: "bg-muted-foreground/25",
	ttft: "bg-chart-5",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	unaccounted: "bg-muted-foreground/12",
} satisfies Record<OccupancyKind, string>

export const OCCUPANCY_LABEL = {
	idle: "Idle · awaiting user",
	ttft: "Time to first token",
	inference: "Inference · streaming",
	tool: "Tool execution",
	unaccounted: "Unaccounted",
} satisfies Record<OccupancyKind, string>

import { Schema } from "effect"

// Sections (collapsible widget groups, optionally tabbed)

export const DASHBOARD_MAX_SECTIONS = 50
export const DASHBOARD_MAX_TABS_PER_SECTION = 20

export const DashboardSectionTabSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
})
export type DashboardSectionTab = typeof DashboardSectionTabSchema.Type

/**
 * A collapsible group of widgets, optionally split into tabs.
 *
 * Invariants — enforced by `sanitizeDashboardSections` on write, deliberately
 * NOT by schema `check`s: `tabs` is non-empty, and every widget carrying this
 * section's id also carries one of its tab ids. A document that violates them
 * must still decode (a widget pointing at a deleted section becomes ungrouped)
 * rather than failing the whole dashboard read.
 *
 * One tab renders as a plain group header; two or more render a tab bar.
 */
export const DashboardSectionSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	// The *stored default* collapse state. Per-viewer overrides ride the URL
	// (`?collapsed=`/`?expanded=`), so one person collapsing a group on their
	// screen never changes what the next person sees.
	collapsed: Schema.optionalKey(Schema.Boolean),
	// Absent or `true`: the group has a chevron and any viewer may fold it away.
	// `false` pins it open — no chevron, and a `?collapsed=` override naming it is
	// ignored rather than hiding a group the viewer has no control to reopen.
	// Use it for the band a dashboard is *about*, which should never be hidden.
	collapsible: Schema.optionalKey(Schema.Boolean),
	tabs: Schema.Array(DashboardSectionTabSchema).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(DASHBOARD_MAX_TABS_PER_SECTION),
	),
})
export type DashboardSection = typeof DashboardSectionSchema.Type

export const DashboardSectionsSchema = Schema.Array(DashboardSectionSchema).check(
	Schema.isMaxLength(DASHBOARD_MAX_SECTIONS),
)

// Section placement/repair helpers moved to `@maple/widgets` alongside the
// section schema they enforce invariants for. Re-exported so
// `@maple/domain/http` keeps its surface.
export {
	containerKeyFor,
	containerKeyOf,
	groupWidgetsByContainer,
	ROOT_CONTAINER_KEY,
	rootWidgets,
	sanitizeDashboardSections,
	type SectionMembership,
	type SectionTarget,
	widgetsInTab,
	withSectionTarget,
} from "@maple/widgets/dashboard"

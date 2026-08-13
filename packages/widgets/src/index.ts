// @maple/widgets — the unified home of what a dashboard widget *is*.
//
// Three layers, all data, no React:
//
//   widget-types.ts   the closed panel-type table: which renderer, which grid
//                     size, which Perses kinds import as it, which display keys
//                     it owns
//   raw-sql-display.ts  how a raw-SQL widget renders
//   dashboard/        the versioned document schema — widgets, display, layout,
//                     sections, variables, plus the migration chain that reads
//                     older stored documents
//
// The package sits BELOW `@maple/domain` and depends on `@maple/primitives` and
// `effect` only. That direction is forced, not chosen: `@maple/domain` uses
// these schemas inside `MapleApi` (`http/dashboards.ts`, `http/v2/dashboards.ts`),
// so anything that owns them has to be importable by domain rather than the
// other way round.
//
// Deliberately NOT here:
//   - Renderers, config panels and icons. They are DOM/Recharts through
//     `@maple/ui`, and `apps/mobile` is React Native, so a component package
//     would be web-only anyway. The web side keys its UI off `PanelType`
//     (`apps/web/src/components/dashboard-builder/widgets/types/`).
//   - `QueryBuilderQueryDraftSchema`. Alert rules persist it too, so it is a
//     shared query primitive rather than a widget concept; it stays in
//     `@maple/domain/http` until it gets a leaf of its own.

export * from "./raw-sql-display"
export * from "./widget-types"
export * from "./dashboard"

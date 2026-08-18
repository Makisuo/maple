// The measurement handle for a chart's plot rect, valid under either renderer:
// Recharts paints `.recharts-cartesian-grid`, TanStack's PlotFrame emits an
// aria-hidden `[data-chart-plot]` sized to the same rect
// (packages/ui/src/components/plot/plot-frame.tsx). Perf specs that don't
// need to distinguish the renderer (unlike tanstack.perf.spec.ts, which is a
// deliberate per-arm A/B bench) select on both so a chart keeps working here
// across its Recharts-to-TanStack port.
export const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"

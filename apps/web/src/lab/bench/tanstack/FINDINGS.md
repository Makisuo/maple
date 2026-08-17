# TanStack Charts pilot — findings

**Date:** 2026-08-17 · **Version tested:** `@tanstack/charts` / `@tanstack/react-charts` /
`@tanstack/charts-scales` **0.14.0** · **Baseline:** Recharts 3.10.1

Supersedes the 2026-08-05 spike, which ported the same three charts to 0.6.4 and was reverted.

Reproduce: `bun run --cwd apps/web test:perf:tanstack`
Look: `/lab/bench/tanstack?renderer=recharts|tanstack-svg|tanstack-canvas`

## 1. Perf

Three arms, identical rows (145 buckets × 3 charts), one 180-step trusted-input pointer sweep
across the first chart. Two consecutive local runs:

| renderer        | React render (ms) | React commits | blocking (ms) | dropped frames |
| --------------- | ----------------- | ------------- | ------------- | -------------- |
| recharts        | 243.6 / 243.6     | 504           | 0             | 0              |
| tanstack-svg    | 94.0 / 77.8       | 146           | 0             | 0              |
| tanstack-canvas | **75.0 / 74.4**   | **146**       | 0             | 0              |

**TanStack Canvas does ~3.3× less React render work and ~3.5× fewer commits than Recharts.**
Commit counts were byte-identical across runs — the gap is structural, not noise: Recharts
drives tooltip state through React on every pointer tick, TanStack updates an imperative scene
and commits only the tooltip body.

Two honest caveats:

- **`totalBlockingMs` is 0 on all three arms on this machine**, so that assertion currently has
  no teeth locally. The discriminating gate is React render work. Blocking time only bites on a
  slower runner (CI).
- This **contradicts the 2026-08-05 result only in appearance.** That spike measured _DOM
  mutations per hover move_ (Recharts 3.7, TanStack 41) and explicitly never measured CPU. Both
  are true: TanStack touches more DOM nodes and spends far less CPU. CPU is what users feel, and
  this is the first valid measurement of it.

## 2. The seven 0.6.4 bugs, re-checked at 0.14.0

| #   | 0.6.4 bug                                                                          | Status at 0.14.0                                                                                                    |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `spec.gradients` dropped by the DOM renderer; `fill: url(#id)` resolved to nothing | **FIXED** — gradients render in both SVG and Canvas, no `<defs>` injection needed                                   |
| 2   | `focus: "group-x"` returns one mark's point, not the group                         | **STILL OPEN** — see below                                                                                          |
| 3   | `whenFocused(dot(...))` renders a dot per datum                                    | **STILL OPEN** — 435 nodes to show 3, but SVG-only; see below                                                       |
| 4   | `areaY` strokes the whole outline incl. baseline                                   | **STILL OPEN** — worked around with fill-only `areaY` + `lineY` on top                                              |
| 5   | No time scale in `charts-scales`                                                   | **STILL OPEN** — `band`/`linear`/`ordinal`/`point` only; `scalePoint` over ISO strings, same as Recharts does today |
| 6   | `<Chart>` needs explicit `width`/`height`                                          | **STILL OPEN** — `useMeasuredSize` in `tanstack-chart.tsx`                                                          |
| 7   | `.ts-chart-tooltip` inline styles with no opt-out                                  | **FIXED** — every inline style is now a `var(--ts-chart-tooltip-*, fallback)`; see below                            |

### Bug 2 is the significant one

`focus: "group-x"` — and the exported `focusGroupX` strategy object, which behaves identically —
returns `points.length === 1` with `group: null`, even with three marks sharing an x scale. So a
grouped tooltip cannot be built from `points`.

The cause is architectural, not a small defect: **TanStack groups by the `z` channel _within_ one
mark**, over long-format data. Recharts' one-`<Area dataKey>`-per-series idiom has no group to
find. Two ways out:

- **What this pilot does:** read the row off `points[0].datum` and render the series from it.
  Preserves mark-for-mark parity with Recharts, so the perf comparison stays fair.
- **The idiomatic fix:** `fold()` to long format and use a single mark with `z`. Cleaner and
  probably faster, but it gives up per-series styling — the dashed error-throughput overlay and
  the p50/p95/p99 stroke variants each need their own mark today.

A real migration would have to pick the second and restructure the data layer. That is a bigger
change than "swap the chart component".

### Tooltip theming (bug 7) is now a solved problem

The shell still writes its own inline styles, but every one is
`var(--ts-chart-tooltip-*, fallback)` — background, color, border, radius, padding, shadow, font,
max-width. Setting those custom properties in a plain class rule wins with **no `!important`**,
which the 0.6.4 notes said was required. `backdrop-filter` and `transition` aren't written inline
at all, so they're set directly.

`tooltip.css` maps them 1:1 onto `chartTooltipCardClassName`
(`packages/ui/src/components/ui/chart.tsx:234`) and the result is pixel-comparable to a Recharts
tooltip: `bg-popover/90`, `border-border/50`, `rounded-xl` (12px), `px-3 py-2`, `shadow-xl`,
`backdrop-blur-md`. The body markup mirrors `ChartTooltipContent`'s rows — swatch, muted label,
right-aligned `font-mono tabular-nums` value.

**Anchor to the pointer, not the datum.** This is the one that matters for feel. The default
`anchor: "point"` pins the card to each bucket's plotted position, and with `placement: "auto"`
it re-picks a side as it goes — measured, a 60px pointer move shifted the card 97px, and it
flipped from the left of the cursor to the right mid-sweep. `ChartFloatingTooltip` anchors at the
cursor with a fixed `side="right"` / `sideOffset={12}` for exactly this reason. Matching it
(`anchor: "pointer"`, `placement: "right"`, `offset: 12`) makes tracking exactly 1:1 — a 96px
cursor move moves the card 96px, always 12px off the pointer.

**No position transition — and "it measured free" was the wrong test.** `ChartFloatingTooltip` can
transition its position because it moves by transform, which the compositor interpolates
independently of the pointer. This shell positions with `left`/`top`, so the same transition makes
the card visibly trail the cursor: it reads as lag. It also cost nothing measurable (canvas 71.3ms
inside a 64–80ms band, commits pinned at 146), which is exactly the trap — the cost was never CPU.
Only opacity is animated, via `@starting-style`, and all of it is disabled under
`prefers-reduced-motion`.

### Focus visuals, and the clearest argument for canvas (bug 3)

The hover affordances match Recharts: a dashed vertical cursor (`crosshair()`, styled from
`--border` — note its default `strokeOpacity` is 0.35, invisible over Maple's dark palette, so it
is forced to 1), a dot on each series at the hovered bucket (`whenFocused(dot(...))`), and the
nearest series' tooltip row bolded.

Two things fell out of building it:

- **Focus grouping works for painting but not for reading.** The dot layer resolves focus _per
  mark_ — all three latency series get a dot — while the tooltip's `points` still carries exactly
  one (bug 2). The same focus state produces a group for one consumer and not the other.
- **Bug 3 is still open, and it is the sharpest illustration of the canvas case.** `whenFocused`
  emits a circle for every datum and sizes the unfocused ones to zero rather than skipping them:
  measured at **435 nodes (145 buckets × 3 series) to display 3**. The canvas arm paints the
  identical result with no DOM at all. Adding the crosshair and both dot layers moved canvas not
  at all (75.2ms / 146 commits, versus 64–80 / 146 before). `tanstack.perf.spec.ts` pins the 435
  count so an upstream fix gets noticed.

### Polar / pie spike (2026-08-17, `/lab/charts`)

`polar` + `pie` + `radialArc` **works**: a donut paints under both renderers, at exactly **one
`<path>` per slice** (5 rows → 5 paths, no per-datum overdraw), with theme tokens resolved to
`oklch` literals. Tooltip reads `42.9%` against the production chart's `43%`.

Four things that will bite anyone building a polar chart:

1. **`focus: "nearest"` silently does nothing on polar marks** — no tooltip, no focus state, no
   error. `focusGroupAngle` (from `@tanstack/charts/polar`) is the polar strategy and works.
2. **The default tooltip body prints raw polar coordinates** — `x 1.336 / y 113.76`, i.e. the angle
   in radians and the radius in pixels. Every polar chart needs its own `renderTooltipBody`.
3. **No hover affordance is possible, and there is no workaround.** No polar mark has `states`, so
   fill/radius cannot react to focus — verified by measurement: hovering changes zero arc
   attributes (`fill`, `fill-opacity`, `transform` all unchanged). The obvious fallback fails too:
   `whenFocused(mark: ChartMark)` cannot wrap a `PolarMark` — `polar({ marks })` requires
   `PolarMark`, and `InitializedPolarMark` carries `colorValues`/`angleValues`/`radiusValues` that
   `InitializedMark` lacks, so it does not typecheck. **The production pie's hover fade + 1.035
   scale cannot be reproduced at 0.14.0 by any route.** Hover feedback is tooltip + legend only.
4. **Row types must not have an index signature.** `pie()` returns
   `Omit<TDatum, PieDerivedField> & …`, and `Omit` over a type with an index signature resolves
   `keyof` to `string | number` and drops every named field — `slice.name` comes back `unknown`.
   Separately, string field-name channels (`startAngle: "startAngle"`) fail to typecheck for the
   same reason, so accessors are mandatory. Normalize to a closed row type at the boundary
   (`toBreakdownRows` already does this).

### Bug 3 is cardinality-dependent, which the earlier note missed

`whenFocused`'s cost is a node **per datum**, so it scales with the data, not the chart. 435 nodes
for a 145-bucket × 3-series timeseries is bad; the same mechanism on a 5-slice pie would be 5. The
distinction matters when deciding where the SVG renderer is still acceptable.

### Two new gotchas not in the 0.6.4 notes

- **Scale factory vs instance.** `scale: scalePoint()` (an instance) silently keeps its empty
  configured domain and the chart renders axes with no marks. `scale: scalePoint` (the factory)
  infers from the data. Pass an instance _only_ to pin a domain — `scaleLinear().domain([0, max])`.
- **No zero anchor.** Recharts' `YAxis` anchors a numeric domain at 0; TanStack's inferred linear
  domain starts at the data minimum, which clipped the p50 line. Needs an explicit configured domain.

## 3. Migration cost for the other 46 files

Two couplings are load-bearing and neither is small:

- **`useLinkedCursor`** (`apps/web/src/hooks/use-linked-cursor.tsx:31`) locates every plot rect via
  the `.recharts-cartesian-grid` selector, and throttles Recharts' tooltip store to 30 Hz by
  `stopPropagation()` in the capture phase — exploiting the fact that Recharts listens in the
  bubble phase. Neither survives a renderer swap. TanStack does ship a first-class replacement
  (`cursor?: ChartCursorBinding` on the chart definition, an app-owned cursor shared across
  definitions), so this is a rewrite onto a better primitive rather than a loss — but it is a
  rewrite, and `infra.perf.spec.ts` / `service-detail.perf.spec.ts` assert the current behaviour
  down to sub-pixel cursor alignment.
- **`ChartTooltipContent`** (`packages/ui/src/components/ui/chart.tsx:425-506`) consumes Recharts'
  `active` / `payload` / `coordinate` props and feeds `ChartFloatingTooltip`. Everything below it
  (`ChartFloatingTooltip`, `useChartTooltipFollow`) is already renderer-agnostic; the adapter layer
  is what needs replacing.

Not counted above: the 15 `chartRegistry` entries, `metrics-grid.tsx`'s `syncMode` switch, and the
`overlay` prop (commit deploy markers) which currently passes Recharts children straight through.

## 4. Verdict

**Perf: go.** Canvas wins on the axis that matters and it is the only path that can — Recharts has
no canvas renderer at all. The 2026-08-05 revert was made on a metric that turned out not to be
the one users feel.

**Timing: not yet.** Still `0.x`, still labelled _"pre-alpha and its API may change between
releases"_, and 8 minor releases landed in the 10 days before this test. Bug 2 alone would force
a data-layer restructure that we would then be carrying against a moving API.

**Recommendation:** keep this bench, don't migrate. Re-run `test:perf:tanstack` when either the
pre-alpha label comes off or grouped focus lands across marks — whichever is later. The pilot is
committed and dev-only, so re-checking costs one command instead of another week-long spike.

---

### Unrelated production bug found in passing

`errorRate` is a **fraction**: the warehouse computes `countIf(StatusCode = 'Error') / count()`
and `apps/web/src/routes/index.tsx:368` documents it as one. `error-rate-area-chart.tsx` agrees
(`formatErrorRate` multiplies by 100; the y domain clamps to 1).

`throughput-area-chart.tsx:96` does not — it computes `errorThroughput` as
`(throughput * errorRate) / 100`, treating the fraction as if it were a percentage. **The error
overlay on the `/` overview's Request Volume chart is therefore 100× too small**, which is why it
renders as a flat line pinned to the axis.

Not fixed here — out of scope, and both arms of this bench inherit the same behaviour, so the
comparison is unaffected.

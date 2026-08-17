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

| #   | 0.6.4 bug                                                                          | Status at 0.14.0                                                                                                      |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | `spec.gradients` dropped by the DOM renderer; `fill: url(#id)` resolved to nothing | **FIXED** — gradients render in both SVG and Canvas, no `<defs>` injection needed                                     |
| 2   | `focus: "group-x"` returns one mark's point, not the group                         | **STILL OPEN** — see below                                                                                            |
| 3   | `whenFocused(dot(...))` renders a dot per datum                                    | **STILL OPEN** — 435 nodes to show 3, but SVG-only; see below                                                         |
| 4   | `areaY` strokes the whole outline incl. baseline                                   | **BY DESIGN** — fill-only `areaY` + `lineY` on top is the documented composition; see below                           |
| 5   | No time scale in `charts-scales`                                                   | **BY DESIGN — we had it wrong.** Compact scales stop at linear/band/point/ordinal; d3-scale is the documented upgrade |
| 6   | `<Chart>` needs explicit `width`/`height`                                          | **NOT A BUG — we had it wrong.** Omit `width`; it follows the container. See below                                    |
| 7   | `.ts-chart-tooltip` inline styles with no opt-out                                  | **FIXED** — every inline style is now a `var(--ts-chart-tooltip-*, fallback)`; see below                              |

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

## The chart gallery (`/lab/charts`, `test:perf:charts`)

Ten TanStack charts (seven when the table below was measured), eight of them beside the production
implementation they'd replace. All render with zero page errors. Ring sweep for the pies, horizontal sweep for the rest, 180 steps.

| chart                       | React ms | commits | verdict                                 |
| --------------------------- | -------- | ------- | --------------------------------------- |
| pie — production            | 22.1     | 18      |                                         |
| **pie — tanstack**          | **4.5**  | **9**   | cheaper, but both trivial — **no case** |
| histogram — production      | 202.0    | 382     |                                         |
| **histogram — tanstack**    | **6.3**  | **11**  | **32× less React work — the real win**  |
| heatmap — production        | 15.4     | 14      |                                         |
| **heatmap — tanstack**      | **2.6**  | **5**   | cheaper, and −325 lines                 |
| line — production           | 228.0    | 410     |                                         |
| **line — tanstack**         | **39.8** | **61**  | **5.7× less React work**                |
| area — production           | 225.0    | 410     |                                         |
| **area — tanstack**         | **38.8** | **64**  | **5.8× less React work**                |
| stacked bar — production    | 195.6    | 374     |                                         |
| **stacked bar — tanstack**  | **20.6** | **24**  | **9.5× less React work**                |
| line + partial — prod       | 222.7    | 410     |                                         |
| **line + partial — ts**     | **36.7** | **61**  | dashed tail is free                     |
| area + partial — prod       | 216.5    | 410     |                                         |
| **area + partial — ts**     | **48.5** | **64**  | dashed tail is free                     |
| box plot — NEW              | 8.5      | 14      | no prior implementation                 |
| trace scatter — NEW         | 59.3     | 169     | 5,000 spans → ~1,900 hex bins           |
| sankey — NEW                | 8.5      | 17      | no prior implementation                 |
| treemap — NEW               | 5.7      | 9       | no prior implementation                 |
| stacked bar + partial — NEW | 22.7     | 24      | recharts bars have no equivalent        |

21 arms, 41.2s, **zero dropped frames and zero long tasks on every one**. Re-measured after the
2026-08-18 rendering fixes below, which changed the box-plot fixture and the trace-scatter domain,
and after the earlier sizing fix — the production charts previously rendered clipped, so the first
table this file carried was not a fair comparison.

**The timeseries arms are the second real consolidation case, after the histogram.** All three
production timeseries charts sit at 374–410 commits, the same per-pointer-tick React tooltip
pattern the histogram shows; the TanStack arms land at 24–64. Note the split within those 61–64:
that is roughly **one commit per bucket crossed** (60 buckets), which is the floor for a tooltip
that changes content — Recharts spends ~7 commits per bucket for the same information. The stacked
bar's 24 is lower still because 24 buckets is all there is to cross.

**Turning the dashed tail on costs nothing.** `line-incomplete` (36.7ms / 61) against `line`
(39.8 / 61) and `area-incomplete` (48.5 / 64) against `area` (38.8 / 64) — identical commit counts,
render time inside run-to-run noise. Three extra marks over a six-row slice do not register.

**The histogram is the strongest consolidation case among the three original pairs, not the pie.** 382 commits vs 11 is the same
structural gap as the overview charts: Recharts drives its tooltip through React on every pointer
tick. The pie's 18-vs-9 is slice-transition-driven in both arms and means nothing.

Two measurement traps this shook out, both now handled in the spec:

- The production heatmap draws **no `<svg>` or `<canvas>`** — it's a CSS grid of divs. Locating on
  `svg, canvas` hangs until the test times out.
- Its grid occupies the top-left of a 320px card, so sweeping the _card's_ centre line crosses
  empty space and records **0 commits** — which reads as "fastest chart in the table" and actually
  means "never responded". The `commits > 0` assertion exists to catch exactly this.

### Parity gaps in the ports (visible in the gallery)

- **Pie**: slice order and colours differ. Production uses `resolveSeriesColors(name)` — stable per
  series name; the spike indexes `--chart-1..5` positionally.
- **Heatmap**: y-axis order is inverted (production runs `300ms+` at top; the spike runs `0-100ms`).
- **Line / area / stacked bar**: colours differ, and the cause is upstream of the port. The
  query-builder charts rename every series to `s1..sN` before colouring, so they always get the
  generic palette; the spikes use the semantic tokens the real chart would (`--chart-p50/p95/p99`,
  `--chart-throughput/error`). Geometry is identical — compare shapes, not hues.

### `clip` is off by default, and marks with extent paint outside the plot

`ChartSpecBase.clip` defaults to **false**, so marks are not bounded to the plot rect. A hexagon is
drawn around its bin _centre_, so `hexbin` bins on the left edge painted half a hex over the y-axis
tick labels. `clip: true` fixes it.

Two follow-ons worth knowing:

- Clipping alone leaves a clipped edge mark sitting ~3px **into** the labels, because the plot rect
  butts straight against them. Tick `padding` is what buys the gap (measured: −3px overlap → +3px
  gap at `padding: 10`).
- This only affects marks whose shape extends around a point. Audited all seven: `hexbin` was the
  only one. `rect`/`cell` are bounded by their band or interval, `boxY`'s glyphs sit inside their
  category, and sankey/treemap are laid out in final pixels. So `clip` is worth setting on
  point-extent marks specifically, not blanket-enabling.

### Two gallery-harness bugs that looked like chart defects

Both were mine, and both initially got written up here as production problems. Recorded because
either would mislead the next person reading a side-by-side.

1. **Charts bled across cards.** `ChartContainer` deliberately sets
   `[&_.recharts-surface]:overflow-visible` so axis labels can escape the SVG box; production
   clamps that one level up at `CardContent`'s `overflow-hidden` (`widget-shell.tsx:213`). The
   gallery card had no clamp, so recharts labels landed on the next chart. **This is not a
   production defect** — I reported it as one.
2. **The production histogram appeared to have no x axis.** `ChartContainer` also sets
   `aspect-video`, and `MetricsGrid` cancels it with `className="h-full w-full aspect-auto"`
   (`metrics-grid.tsx:127`). Without that class the chart sizes itself 16:9 — taller than a 320px
   card — and the axis is pushed out and clipped. The gallery now passes the same class, and the
   labels render fully inside the card, evenly spaced and **not** colliding. An earlier note here
   claiming they collide was wrong.

The `split("-")[0]` bug in `query-builder-histogram-chart.tsx:122` is unaffected by either — it is
a code-level fact (a negative lower bound yields `""`, and the `||` fallback then prints the whole
unsplit range), confirmed by reading rather than by rendering.

### Polar / pie spike (2026-08-17, `/lab/charts`)

`polar` + `pie` + `radialArc` **works**: a donut paints under both renderers, at exactly **one
`<path>` per slice** (5 rows → 5 paths, no per-datum overdraw), with theme tokens resolved to
`oklch` literals. Tooltip reads `42.9%` against the production chart's `43%`.

Four things that will bite anyone building a polar chart:

1. **`focus: "nearest"` silently does nothing on polar marks** — no tooltip, no focus state, no
   error. `focusGroupAngle` (from `@tanstack/charts/polar`) is the polar strategy and works.
2. **The default tooltip body prints raw polar coordinates** — `x 1.336 / y 113.76`, i.e. the angle
   in radians and the radius in pixels. Every polar chart needs its own `renderTooltipBody`.
3. ~~**No hover affordance is possible, and there is no workaround.**~~ **CORRECTED 2026-08-18 —
   this was wrong, and instructively so.** Everything it observed still holds: no polar mark has
   `states`, hovering changes zero arc attributes, and `whenFocused(mark: ChartMark)` genuinely
   cannot wrap a `PolarMark` (`polar({ marks })` requires one, and `InitializedPolarMark` carries
   `colorValues`/`angleValues`/`radiusValues` that `InitializedMark` lacks). The error was the
   conclusion drawn from it — "cannot be reproduced by any route" — reached by only ever looking
   *inside* the chart definition.

   The route is above it. **`onFocusChange` on the Chart component** reports the focused datum to
   React, and a **second `radialArc` over just that slice** gives it its own radius and opacity.
   Per-mark options stop being a limitation once the mark list is a function of hover state. The
   production pie's fade + 1.035 scale is now reproduced exactly — measured on the SVG arm, the
   hovered wedge's bbox goes 144×272 → 149×281 (1.035) while the other four drop to
   `fill-opacity="0.55"`.

   The cost is a rebuilt definition per slice crossing, which is affordable only because
   `onFocusChange` is **edge-triggered** — it fires when the focused datum changes, not on every
   pointer move. That distinction is the whole reason this is viable rather than a per-tick React
   storm, and it is worth remembering for any other mark family that lacks `states`.

   General lesson for the rest of this document: "the mark cannot express X" and "the chart cannot
   do X" are different claims, and this file conflated them once already.
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

### Timeseries arms: line, area, stacked bar, and the dashed partial tail (2026-08-17)

Added to `/lab/charts` as five pairs plus one solo arm, over
`apps/web/src/lab/charts/timeseries-data.ts`. Two findings, one in each direction.

**1. The `_incomplete` twin-column trick is a Recharts workaround, not a requirement.**

`markIncompleteSegments` (`packages/ui/src/lib/incomplete-buckets.ts`) rewrites every row into
`key` / `key_incomplete` column pairs and duplicates one value into both to bridge the join. It has
to: a `<Line dataKey>` is a **string**, so one series can carry exactly one dash style, and a
solid-then-dashed line is therefore two series.

TanStack channels are accessors, so the same picture is **two marks over two slices of the same
array** — `rows.slice(0, first)` and `rows.slice(first - 1)`, where the shared row at `first - 1`
_is_ the bridge point. No row is copied, no column is invented, and the row type stays closed.
`splitAtFirstPartial` is nine lines against that function's ninety-seven. `lineY.strokeDasharray`
being a plain `string` is what makes it work; `areaY` has none at all (bug 4's neighbour), so a
dashed area edge is still a faded fill plus a dashed `lineY` — the same composition the Recharts
arm uses, for the same reason.

**2. `barY.strokeDasharray` is a per-datum `VisualChannel` — the one place TanStack is strictly
more capable.** A partial bucket's bars dash inline, no twin series and no second stack id.
Compare `query-builder-area-chart.tsx:421-443`, which needs its own `stackId: "b"` to reproduce
the stack geometry for its dashed twin, and `query-builder-bar-chart.tsx`, which never calls
`useIncompleteSegments` at all — **Recharts bars have no partial-bucket rendering in Maple today**.
That is why `stacked-bar-incomplete-tanstack` has no production counterpart to pair against.

Also: `barY` stacks through the `z` channel over **long-form** rows (one row per bucket per
series), where Recharts needs a `<Bar dataKey>` per service over wide rows. Adding a series becomes
a data change instead of a JSX change.

**Fixture note — the partial fixtures are anchored to wall-clock `now`, deliberately.**
`QueryBuilderLineChart` rebuilds its rows as `{bucket, s1..sN}` before calling
`useIncompleteSegments`, so a `partial` flag set upstream never reaches `markIncompleteSegments`
(and passing it through would register `partial` as an extra series). The production arm can only
infer partiality from the spacing + wall-clock heuristic, and a fixed 2026 timestamp exercises
nothing. `timeseries-data.ts` evaluates that same predicate against one captured `NOW_MS`, so both
arms classify the same buckets and the dashed tail starts at the same one. The plain arms keep the
fixed past anchor and stay fully deterministic.

**Bug 3 is unchanged, and an earlier revision of this section said otherwise.** It claimed
`whenFocused` had regressed to painting every dot at full radius, on the evidence that all 180
emitted circles carry `r="3.5"`. The radius is real; the conclusion was not. The dots are hidden by
`visibility: hidden` on their group, not by a zero radius, so nothing is painted at rest and the
lines are not beaded — what looked like beading in a screenshot was a 1214→800px downscale. The
original finding stands as written: the waste is DOM nodes, not pixels.

**Measured.** `test:perf:charts` now covers 21 arms (41.2s); the numbers are in the table above.
The headline: the three production timeseries charts are 195–228ms / 374–410 commits against
20–40ms / 24–64, and switching the dashed tail on is free.

### Six rendering defects found by looking at the gallery (2026-08-18)

Every one of these was invisible in the perf numbers and obvious on screen. Four are library
constraints worth carrying into a migration decision; two were ours.

**1. `lineY` forces round line caps, and it silently eats dash gaps.** `dist/line.js:123-124` sets
`lineCap: "round"` / `lineJoin: "round"` on every node, and `LineYOptions` exposes no `lineCap`. A
round cap adds `strokeWidth / 2` of ink to BOTH ends of every dash, so Recharts' `"4 4"` — crisp
there, because `<Line>` leaves the default butt cap — paints `4 + w` on against a `4 - w` gap here.
At a 2.5px stroke that is 6.5px of ink and a 1.5px gap: the incomplete tail rendered as a wobbly
solid line. `roundCapDasharray(on, off, strokeWidth)` in `chart-shared.tsx` takes the cap out of the
dash and gives it to the gap. **Anyone porting a dashed Recharts series must do this conversion or
the dash disappears.**

**2. `radius` on a stacked `barY` cannot round only the outer corners.** It is a flat `number`
handed to one rect node per SEGMENT (`dist/bar.js:142`), and the renderer's `beginRoundedRect`
(`dist/canvas.js:637`) applies it to all four. So a stack is either rounded at every interior seam
or square throughout — there is no per-corner or per-stack-position form. Recharts' `<Bar radius>`
takes `[tl, tr, br, bl]`, so this is a genuine capability loss. The spike is square.

**3. `boxY`'s `inset` is not the width knob it appears to be.** It forwards to the internal `barY`'s
inset, which the renderer clamps: raising it from 10 to 26 moved the drawn box by about two pixels
(measured, 92.29px wide either way). `paddingInner` on a **pinned** band scale is what actually
sizes a box — 0.55 took it to 65.73px. The cost is that the domain must then be supplied by hand.

**4. `clip: true` is not enough for point-extent marks; the domain has to be padded.** The earlier
note here says `clip` fixed `hexbin` painting over the axis labels. It stopped the overpaint, but
the edge bins are still CENTRED on the plot edge, so the chart ended in a column of half-hexagons
that were visibly truncated and yet still hit-tested and still opened a tooltip — the shape lied
about the bin and the target no longer matched the paint. Padding the x domain (~1.6% of span,
roughly one bin) moves those centres inward. `clip` goes back to being a backstop.

**5. A chart is a figure, not prose.** Neither renderer sets `user-select`, so dragging across a
chart — which is what hovering a timeseries looks like — started a text selection and painted the
browser's selection highlight over the whole `<svg>`/`<canvas>`. `select-none` on
`TanstackChartFrame`. Recharts never showed this because `ChartContainer`'s content is unselectable
by construction.

**6. `"currentColor"` is not a portable fill.** The heatmap's hover ring used it: it resolves by
inheritance on SVG and resolves to nothing on canvas, so the affordance silently differed between
the two arms. Every colour in a chart spec has to be a resolved literal — which is the entire reason
`usePlotColors` exists, and the rule was already written down two sections above. (The same state
also dropped `inset` to 0 on hover, growing the cell by a pixel a side, so the ring arrived with a
size jump that read as the grid twitching.)

Ours, not the library's: the box plot's fixture. It summed sine terms for the spread and then
multiplied every 17th sample by ~2.6 to manufacture outliers, which gave every operation a narrow,
near-symmetric IQR while pushing the axis maximum to ~4× the tallest box — every box collapsed to a
few pixels and the chart read as a bar chart. Replaced with a seeded lognormal (the generator
`trace-scatter-spike.tsx` already had), which produces its own outliers past 1.5×IQR, plus a **log
y axis**: latency across operations spans orders of magnitude, and on a zero-anchored linear axis
the fast operations' boxes sit on the baseline while the slow one's outliers set the scale. The
shared `createLogScale` in `lab/charts/log-scale.ts` is that scale — `charts-scales` still ships no
log scale, so this lab now has one implementation instead of the two copies it had grown.

### Legends: the package ships three, and most of these charts can use none of them (2026-08-18)

Every `QueryBuilder*Chart` on the production side of the gallery renders `QueryBuilderLegend`.
Until now no TanStack arm rendered a series legend at all, so half the pairs above were comparing
a chart with a legend against a chart without one. The `*-legend-tanstack` arms close that, and
finding out how was the more interesting half.

**`@tanstack/charts` has `colorLegend`, `colorGradientLegend` and `interactiveColorLegend`, and
all three hang off `ChartColorOptions.legend` — a key that only exists once the chart declares a
chart-level `color:` scale.** A mark therefore has to take its paint FROM that scale. Eight of the
ten spikes do the opposite: they set a literal `stroke`/`fill` per mark, because Recharts' idiom is
one `<Line dataKey>` per series and these ports deliberately preserve that shape mark-for-mark.

So the split is structural, not stylistic:

| Chart                  | Package legend reachable? | Why                                                                                                                                                          |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stacked bar            | **yes**                   | already groups by `z`; `barY` has a `color` channel, so `fill: (d) => colorFor(d.service)` becomes `color: (d) => d.service` plus a chart-level domain/range |
| heatmap, trace scatter | yes (already used)        | continuous `color:` scale — but a gradient ramp, not a series key                                                                                            |
| line, area             | no                        | one mark per series with a literal stroke; reaching a colour scale means rebuilding both around long-format rows and a `z` channel                           |
| pie                    | no                        | `radialArc` reads no colour scale, the same wall its missing hover affordance hit                                                                            |
| treemap, sankey        | no                        | `fill`/`stroke` are computed per node from data (`serviceColor`, error rate), not scaled                                                                     |

`stacked-bar-legend-scene-tanstack` is the one arm where both are reachable, which makes it the
only place the two can be priced against each other — see the second test in
`charts-lab.perf.spec.ts`. What the in-scene legend buys: zero DOM. What it costs: no Tailwind,
no shared styling with the tooltip, `ChartLegendPlacement` is `'top' | 'bottom'` only (production's
`legend="right"` is not expressible), and no stats columns.

**Two things about that arm are sharp enough to be worth the whole exercise.**

_Declaring both `z` and `color` produces a legend that silently filters nothing._ `barY` derives
its series from `color` only when `z` is absent (`dist/bar.js:27`), and sets `seriesFromColor` only
when `z` is absent AND the layout is grouped or the x positions repeat (`dist/bar.js:50`).
`interactiveColorLegend`'s `filterMark` short-circuits on `seriesFromColor`. Declaring both — the
obvious reading, since `z` is exactly what the DOM variant uses to stack — gives a legend that
renders, toggles, updates `aria-pressed`, and removes nothing. Dropping `z` fixes it; the stack
then groups by the colour channel instead.

_And on a stack it punches a hole rather than restacking._ `filterMark` runs on the RESOLVED
scene, after `stackValues` has assigned every segment its y1/y2, and there is no hook between the
layout and the filter to re-run it. So hiding the bottom band deletes its rects and leaves the
survivors floating at their old offsets, with a gap along the baseline — verified in the browser,
and the reason that arm pins its y domain to the full total (a domain over the visible services
would crop a picture that still occupies its original height). **For a stacked chart the package's
legend is a display control, not a data control** — which on current evidence rules it out for the
query-builder bar chart. The DOM arm sidesteps the whole question by highlighting instead of
hiding: nothing is removed, so nothing needs restacking.

`interactiveColorLegend`'s state model is the good part and worth stealing regardless:
`controlledSignal(value, onChange)` is explicitly "application-owned state described to the chart"
— it creates no store and no subscription of its own, so the visible set is plain React state
exactly as the DOM legend's hidden set is. Note `seriesVisible` "keeps hidden series in scale
inference while removing their scene output", which is right for a colour scale and wrong for a y
axis: the y domain still has to be re-pinned by hand.

The DOM legend is `lab/bench/tanstack/chart-legend.tsx`, a compound component
(`ChartLegend.Provider/Row/Column/Items/Item/Swatch/Label`) with `useChartLegendHighlight`
alongside. State lives with the chart, not the legend, because emphasis is expressed in the marks.

**Clicking a series highlights it; it does not hide it.** This is a deliberate departure from
`QueryBuilderLegend`, which toggles visibility, and it is the better interaction on every chart
here for the same underlying reason: removing a series changes the geometry of everything else.
On a line chart the y domain re-derives and the axis jumps. On a pie, `pie()` renormalises every
remaining angle, so the whole donut rearranges around the slice you just clicked. On a treemap,
`squarify` reruns and every surviving tile changes both size and position — the reader loses the
mosaic they were reading. On a sankey, dropping edges shrinks the derived node set and the columns
move. Highlighting leaves all of it in place and just quiets the rest, so a series can be picked
out of a crowded chart without losing its context. Clicking the same item again restores full
strength.

**How emphasis is expressed is a package constraint, not a preference.** `fillOpacity` and
`strokeOpacity` are flat `number`s on every mark in the package — `bar.d.ts`, `area.d.ts`,
`polar.d.ts`, `hierarchy-treemap.d.ts`, `line.d.ts` all declare them that way — while `fill` and
`stroke` are `VisualChannel`s. So it splits:

- **line, area** draw one mark per series, so a flat `strokeOpacity`/`fillOpacity` on that mark
  already is per-series. No colour arithmetic.
- **stacked bar, pie, treemap, sankey** draw every series from ONE mark, so there is no per-datum
  opacity to reach for and a muted series has to be a muted _colour_. That is `muteColor` in
  `lab/charts/color-scale.ts`, mixing toward `--background` with the `mixOklch` machinery the
  heatmap ramp already needed — for the same reason it needed it, that canvas takes literal colours
  and cannot resolve a `color-mix()`.

The single-mark charts express it without a new prop at all: they already paint through a
`colorFor(key)` lookup, so the legend variant hands down a `colorFor` that returns muted colours.

Worth noting against the package's own legend: `interactiveColorLegend` can only _hide_ — its
contract is a `visible` array and a `filterMark` that deletes scene output. There is no emphasis
mode, so the interaction the spikes settled on is not expressible through it even on the one chart
where it applies.

**Not ported: the Min/Max/Mean/Last stats table.** `QueryBuilderLegend`'s stats variant reads
`Record<string, unknown>` rows by key; the spikes have closed per-chart row types and accessor
channels. It is a data-shape coupling, not a rendering one, and porting it would mean giving every
spike an index signature — the exact thing `pie-spike.tsx` documents as poisoning `Omit`/`keyof`
across the package.

Two things fixed in passing, both the same bug: `pie-spike` coloured slices by
`palette[slice.index % palette.length]` and `treemap-spike` by first-seen order over the rows it
was handed. Both are indexes into a _filtered_ list, so hiding one slice or service renumbered
everything after it and recoloured the chart. Colours are now keyed by name over the full row set.
A legend that repaints the series it did not touch is worse than no legend.

### The docs audit: three of our "gaps" are documented features (2026-08-18)

Prompted by "is there an example in the docs?", every workaround in this pilot was re-checked
against the published guides. Three of them existed because nobody read them.

**1. d3-scale is the documented upgrade path, not a last resort.** The
[Scales and D3 guide](https://tanstack.com/charts/v0/docs/concepts/scales-and-d3) is explicit:
the compact scales cover "numeric linear, categorical band and point, and ordinal mappings without
a production D3 dependency", and you install `d3-scale` when you need more. Its own examples are
`scaleLog().domain([200, 30_000])` and `scaleUtc` — the exact two scales this lab hand-rolled.

`histogram-spike.tsx` had reasoned itself out of this: d3-scale _is_ in the bun store transitively
via Recharts, `require.resolve` fails from `apps/web`, "so importing it would mean adding a
dependency". Adding the dependency was the answer. The guide even anticipates the confusion —
"Do not declare a D3 module merely because another package uses it internally" — i.e. declare it
because _you_ import it, which we now do.

`d3-scale@4.0.2` + `@types/d3-scale` are direct deps of `apps/web`, `lab/charts/log-scale.ts` is
deleted, and the box plot, histogram and trace scatter use `scaleLog()`. Two things got better for
free: d3 supplies proper log `ticks`/`tickFormat` (the trace scatter now labels clean decades
instead of the 1/3-mantissa set the hand-rolled version emitted), and `invert` — which `hexbin`
requires and which was the fiddliest part of the hand-rolled scale.

Factory-vs-instance applies, and the first version of this paragraph got it exactly backwards.
`isScaleFactory()` is `typeof source === "function" && !("copy" in source)`, and **`copy` lives on
the instance, not on the factory function** — `"copy" in scaleLog` is `false`, `"copy" in scaleLog()`
is `true`. So a bare `scaleLog` is read as a FACTORY and infers its domain from the data, exactly as
the docs' `x: { scale: scaleUtc }` example relies on. Calling it is a deliberate choice to pin a
domain, not a defensive one; the log charts here call it because they each want a domain the data
alone would not give (`[1, max]` for counts, a padded `[min, max]` for the box plot, a fixed
estimate for the density ramp).

**2. Bug 4 is not a bug.** "`areaY` strokes the whole outline incl. baseline" was filed as a defect
worked around with a fill-only `areaY` plus a `lineY`. That composition is the documented pattern —
the [Lines and Areas](https://tanstack.com/charts/v0/docs/examples/lines-and-areas) examples layer a
filled interval mark with a separate centre line for exactly this reason. Nothing to change; the
table entry was miscategorised.

**3. Continuous colour has a documented shape we did not use.** `lab/charts/color-scale.ts` is 248
lines of hand-rolled oklch parsing, hue interpolation and a bespoke `ConfiguredScaleLike`. The
[Legends and Color guide](https://tanstack.com/charts/v0/docs/guides/legends-and-color) says to
compose `scaleSequential` from d3-scale with an interpolator. **Not yet changed** — see below.

### 4. A real time scale on the timeseries x axes

Line and area used `scalePoint` over ISO **strings** — categorical, which is what Recharts does and
why axis labels landed on arbitrary buckets (`08:25 PM, 08:45 PM, 09:05 PM`) instead of on clock
boundaries. They now use a d3 temporal scale, and the ticks land on quarter hours
(`09:00 PM, 09:15 PM, 09:30 PM…`). `TimeseriesSpikeRow` carries a precomputed `date: Date` beside
`bucket`; `bucket` stays because the production Recharts arms and `markIncompleteSegments` both
parse it.

Three things worth keeping:

- **`scaleTime`, not the docs' `scaleUtc`.** `formatBucketLabel` renders ticks in local time via
  `toLocaleTimeString`, and only local-time ticks land on locally round boundaries — UTC ticks would
  read `:15`/`:45` in a fractional-offset timezone. The docs example is UTC because it assumes a UTC
  formatter; the rule is that the scale and the formatter have to agree.
- **The tick formatter fails silently, not loudly.** `formatBucketLabel` opens with
  `if (typeof value !== "string") return ""`. The moment the x channel yields a `Date`, the axis
  keeps its ticks, its spacing and its layout — and every label becomes an empty string. Ticks now
  round-trip through `value.toISOString()`, which is the same code path the string buckets took.
- **`Date`, not epoch milliseconds.** The runtime throws
  `"A temporal scale factory requires Date channel values"` on numbers (`dist/scale-input.js`);
  `ChartValue` is `number | string | Date`.

The x domain is no longer pinned. It was pinned because the solid and dashed marks cover different
slices, but that hazard was about categorical union ORDERING — a continuous scale takes min/max over
the union, which is order-independent, and the slices overlap at the bridge row anyway.

### Still open after the audit

- **`color-scale.ts` → `scaleSequential`** — in progress at the time of writing.
- **`interactiveColorLegend`** — resolved separately, and against adopting it: see the legend
  section above. It is a display control, not a data control, and on a stack it punches a hole.

### Bug 6 was never a bug, and believing it cost us a mount flash (2026-08-18)

The table above carried "`<Chart>` needs explicit `width`/`height`" from the 0.6.4 notes, and
`tanstack-chart.tsx` acted on it: a `useMeasuredSize` hook that observed the container and rendered
`null` until it had both numbers. That is the opposite of how the component is meant to be used, and
it is what made every chart flash blank for ~100ms on load.

What the package actually does, all of it verifiable in `node_modules`:

- `width` is **optional**. The host renders `width: width === undefined ? "100%" : width`
  (`dist/react/RendererChart.js`), so omitting it makes the chart fill its container.
- The renderer installs **its own `ResizeObserver`** on the container (`dist/renderer.js:151`).
- `adapter.mount()` runs inside a **layout effect**, and `createScene()` reads
  `container.getBoundingClientRect().width` synchronously there (`dist/renderer.js:659`) — so the
  first paint is already correctly sized. The `initialWidth: 640` prerender is the SSR placeholder,
  replaced before paint on the client. That default is what the 0.6.4 note mistook for "no
  intrinsic sizing".

Gating on our own observer broke exactly that: `observe()` never calls back inline, so the sequence
was mount → paint an empty card → first record arrives in a later frame → re-render → paint the
chart. Two blank frames minimum, twenty-one charts on the gallery, each with its own delivery and
its own React commit.

The guide says this plainly — omit `width` to follow the container, and choose `height` **or**
`aspectRatio`, never both: <https://tanstack.com/charts/v0/docs/guides/responsive-charts>

`height` genuinely does have to be a number, and that part is not a workaround: the scene height
comes from `options.height ?? 320` and is never read back off the container
(`dist/renderer.js:664`), so a CSS `height: 100%` yields a full-height host drawing a 320px scale.
These charts sit in a flex column whose spare height depends on whether a legend wrapped, so it is
measured — synchronously in a layout effect, with a fallback so rendering is never _gated_ on the
measurement. Width is left entirely to the package.

**The transferable lesson:** the two workarounds in this file that were pure cost — this one and
the `"currentColor"` hover ring — were both cases of trusting a note in this document over the
installed source. `node_modules/@tanstack/charts/dist` ships readable JS and full `.d.ts`; the
package is pre-alpha and its notes go stale faster than its code.

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

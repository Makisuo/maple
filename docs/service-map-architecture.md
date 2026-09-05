# The service map's data path

The map is the densest read surface in the product: one page load fans out across four
warehouse tables, two rollups a scheduled job fills, and two control-plane inventories, then
merges all of it into one graph. This is what it reads today, what the invariants are, and
where it is going — read it before adding another overlay.

---

## What one page load costs

| Request                   | ClickHouse queries                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `serviceMapBundle`        | `serviceDependencies`, `serviceOverview`, `serviceDbEdges`, `servicePlatforms`, then `serviceWorkloads` |
| `serviceCloudflareStats`  | `cloudflareServiceCounters`, `cloudflareServiceLatency`                                                 |
| `servicePlanetScaleStats` | `planetscaleServiceGauges`, `…Connections`, `…Storage`                                                  |
| control plane             | `planetscaleIntegration.databases`, `integrations.cloudflareHyperdrives`                                |

Clicking a database node adds three more (`serviceDbQuerySummary`, `…Timeseries`,
`…TopQueries`); clicking a PlanetScale node adds `planetscaleBranchStats`.

Two things about that table are not yet true but should be:

- **The Cloudflare and PlanetScale query sets run unconditionally.** An org with neither
  integration still pays five metrics scans per load to render nothing — and the inventory
  that would prove them empty arrives in a _different_ request.
- **`serviceOverview` is the services-_list_ query.** 500 rows, each carrying a 20-element
  `commits` tuple array built by a per-commit `GROUP BY` and tDigest merge. The map reads
  four fields off it. Its cache entry cannot be shared with `/services` either: cache
  identity is the raw payload, and the two callers pass different request classes.

---

## The tiers, and the invariant that binds them

Every edge query reconstructs its window from two sources: an hourly rollup for the whole-hour
interior, and raw rows for the two partial hours at the ends.

| Layer              | Interior tier                        | Raw tier                                     | Filled by            |
| ------------------ | ------------------------------------ | -------------------------------------------- | -------------------- |
| service → service  | `service_map_edges_hourly`           | `service_map_spans` ⋈ `service_map_children` | **scheduled rollup** |
| service → database | `service_map_db_edges_hourly`        | `traces`                                     | MV                   |
| service → external | `service_external_edges_hourly`      | `traces`                                     | MV                   |
| db query shapes    | `service_map_db_query_shapes_hourly` | `traces`                                     | MV                   |

**The two tiers must tile the window exactly once — no gap, no overlap.** That boundary is
not written per query; it comes from `ch/queries/rollup-splice.ts`, and
`unsplicedTwoTierQueries` in the SQL catalog fails any two-tier query that computes its own.
See [warehouse-rollups.md](warehouse-rollups.md) for the rule and the bug that motivated it.

`service-map-parity.clickhouse.e2e.test.ts` is the numeric proof: it seeds spans exactly on
each seam and one second either side, then compares each spliced query against a flat scan of
raw `traces`. Boundary-exact rows are the only ones that expose a tiling bug — everything else
passes whether the inequalities are complements or not.

### Service→service is the fragile one

It is the only layer whose interior tier is filled by a **scheduled job**
(`ServiceMapRollupService`, hourly at `0 * * * *`) rather than a materialized view — the
downstream service name is only recoverable by joining a Client/Producer span to its child
Server/Consumer span, which an MV cannot express.

Two consequences, both open:

- The read path has **no fallback for a complete-but-unsealed hour**. Between the hour
  elapsing and the tick reaching that org, the hour is simply missing from the map.
- `LOOKBACK_HOURS = 6`. A worker outage longer than that is a **permanent** hole: the source
  spans live 30 days, but nothing ever goes back for them.

The fix for both is a per-org rollup watermark — splice at the watermark rather than at
`toStartOfHour`, falling back to the live join for any unsealed hour, so a late tick degrades
into slower-but-correct instead of a gap.

### Presence queries are deliberately not spliced

`servicePlatforms` and the external-edge anti-join's `internalResolutions` subquery ask "did
any span in this window carry this attribute", not "how many". They read only their rollup,
with loose hour bounds. Over-inclusion costs a slightly stale platform badge; splicing them
would mean scanning raw spans at both ends to place a label. They never trip the gate because
they name no raw table.

---

## Adding a layer

Today a new overlay touches roughly nine files: the CH query, `ch/index.ts`, a registry entry,
a domain response field, a branch in the `serviceMapBundle` handler, a web transform, an atom,
a prop threaded through `ServiceMapView` → `ServiceMapCanvas` → `buildFlowElements`, and a
merge loop inside that function — whose input interface is now twelve optional fields.

Each layer independently re-decides four things, and each is a chance to drift:

| Concern           | Owned by                                     | Should be                           |
| ----------------- | -------------------------------------------- | ----------------------------------- |
| window boundary   | `rollup-splice` ✅                           | done — enforced by the catalog gate |
| fan-out + caching | a hand-written `Effect.all` per handler      | one runner over declared layers     |
| wire shape        | `Schema.Record(String, Unknown)` passthrough | typed rows                          |
| client merge      | a new prop + a new loop                      | one contribution point              |

The direction, not yet built:

1. **A layer registry.** A layer declares its query, whether it contributes topology or
   decoration, and what capability it requires. The handler, the response schema, the atom
   and the client merge all derive from it instead of each growing a branch.
2. **Capability gating.** Resolve the org's capabilities once per bundle and skip layers that
   cannot have data. This is what keeps layer #15 from costing every org a scan.
3. **Topology / decoration split.** Topology layers (service edges, db edges, a slimmed
   overview) gate layout; decoration layers (platforms, runtimes, workloads, Cloudflare,
   PlanetScale) stream in and refine nodes in place. That keeps time-to-first-map flat as
   layers are added.
4. **A contribution model** on the client: `buildFlowElements` takes a list of
   `{ nodes?, edges?, decorations? }` keyed by node id, so a new overlay changes no signature.

---

## Statistics: one name, one meaning

A database node and the panel that opens when you click it read the **same edges**. They must
therefore render the same statistic, and for a long time they did not — a ScyllaDB node showed
`3s` and `3k/s` beside a panel showing `7ms` and `30k/s` off the same data. Two separate
causes, both now fixed, both worth not reintroducing:

- **Counts are sample-weighted everywhere.** The node divided the raw `callCount` and
  hardcoded `hasSampling: false`, while the panel used `estimatedQueryCount`. At a sample rate
  of 10 that is a flat 10× disagreement. Database nodes now carry `estimatedCallCount`,
  `hasSampling` and `samplingWeight` through from the edges, exactly as service nodes carry
  them from the overview, and render the `~` estimate prefix.
- **`maxDurationMs` is a max, and is named that.** The edge rollups store `MaxDurationMs` and
  carry no quantile state, so there is no p95 at edge grain. It was called `p95DurationMs`
  from the SQL alias all the way to a "P95 Latency" label — 3s (the slowest call in 12 hours)
  against the panel's real merged-tDigest 7ms p95. The field is renamed end to end, and
  `ServiceNodeData` keeps `p95LatencyMs` (service nodes, a real p95) and `maxLatencyMs`
  (database nodes, a max) as separate optional fields so they cannot be confused again.

The related rule: **a loading fallback may substitute a different source, never a different
statistic.** The panel's P50 and P95 tiles used to fall back to the edges' mean and max until
the summary resolved, so the number changed meaning — and magnitude — a second after opening.
They now render an em dash while waiting. Counts still fall back, because the edge estimate
and the summary estimate are the same statistic.

Storing a tDigest state in the edge rollups would give nodes a real p95 and is the remaining
half of this; renaming was the cheap half.

## 2D and 3D presentation

`/service-map` stores its renderer choice in the `view=2d|3d` search parameter; 2D remains
the default. The lazy-loaded voxel factory renderer in `components/service-map/three` consumes
the same resolved `buildFlowElements` graph after decluttering, including integration
nodes and links. It adds no warehouse queries. Environment, time range, focus, traffic
thresholds, namespace expansion, and service/database detail panels remain shared.

The live adapter preserves sample-weighted node and edge rates and their estimate markers.
Service p95 and edge average/max retain their original meanings. Structural Hyperdrive
origin links stay idle. Atlas groups by the actual namespaces; Cascade condenses dependency
cycles before assigning depth. Layout and route geometry depend on graph structure, so a
metric refresh updates the factory without resetting the camera. The lab uses this same
renderer with explicitly labeled fixture traffic.

The voxel scene uses 0.4-unit terrain steps, 0.2-unit tree blocks, and 0.1-unit
machine shells, with finer mechanical details. `voxel-geometry.ts` emits only the
exterior faces of each machine part; `voxel-landscape.ts` builds two instanced
batches for terrain and plants and omits buried soil blocks. The landscape receives
structural routes separately from live edge metrics, so traffic refreshes do not
rebuild it. Warm/cool lighting uses a stable soft shadow map refreshed on geometry
changes. Pause and reduced motion stop scene animation; HTML labels and the shared
service inspector retain keyboard access.

## Known-unresolved

- The DB summary and its own chart use different windows for ranges ≤24h: the chart reads raw
  traces over the exact window, the card above it reads the hourly rollup.
- Edges are `LIMIT 200` while the overview is `LIMIT 500`, so past 200 edges the map silently
  draws nodes with no edges and says nothing about it.

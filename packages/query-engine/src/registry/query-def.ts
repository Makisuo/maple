import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import type { WarehouseCapabilities } from "../capabilities"
import type { QueryProfileName, WarehouseQuerySettings } from "../profiles/query-profile"
import type { DirectRouteCachePolicyInput } from "../runtime/query-engine"

/**
 * One warehouse query, declared in one place.
 *
 * The problem this solves: every handler in `query-engine.http.ts` wires its own
 * cost profile, span context, error label and — if the author remembered —
 * caching. Caching being opt-in per call site meant silence read as "off": 11 of
 * 61 handlers called `cachedDirect`, the other 50 were uncached by omission
 * rather than by decision. Nothing in the type system asked.
 *
 * A `QueryDef` makes those choices data instead of boilerplate, so `runQuery`
 * can apply them uniformly and a reviewer can see all of them at once. The
 * single most important field is `cache`, which is REQUIRED and nullable rather
 * than optional: `cache: undefined` is a decision someone made, a missing
 * `cache` is a compile error.
 *
 * Scope note: this deliberately does NOT own row decoding or response shaping.
 * Handlers still map rows into their own response class. Folding hand-coercion
 * (`Number(row.count)`, `decodeFingerprintHash(...)`) into a declared
 * `rowSchema` is a real improvement but a separate, riskier change — it turns
 * ClickHouse's UInt64-as-JSON-string behaviour into a hard failure where it is
 * currently a silent `Number("123")`, and every migrated query has to go
 * through the DESCRIBE sweep (`bun run ch:up && bun run ch:test`) to prove it.
 * Keep the two changes apart so a decode regression is never tangled up with a
 * caching change.
 */
export interface QueryDef<Payload, Row> {
	/**
	 * Stable identifier. Used as the warehouse span's `query.context`, as the
	 * `cachedDirect` route name (and therefore part of the cache key), and as the
	 * error label. One id, so those three can never drift apart the way they can
	 * when each is passed as its own string literal.
	 *
	 * Where a pipe name already exists for the same logical query, use it — the
	 * goal is one vocabulary, not a sixth.
	 */
	readonly id: string

	/**
	 * Cost profile, applied as ClickHouse `SETTINGS`. Defaults are NOT inherited
	 * here: state it, because "which budget does this query get" is exactly the
	 * kind of decision that goes stale silently when it is implicit.
	 */
	readonly profile: QueryProfileName

	/**
	 * Extra settings merged over the profile — e.g. `LOGS_BODY_SEARCH_SETTINGS`
	 * for log body search, whose `maxBlockSize: 512` is the difference between a
	 * sub-2s query and an OOM on a large-body org.
	 *
	 * May be a function of the payload, because whether a query needs them can
	 * depend on the request: `listLogs` only wants the body-search settings when
	 * the caller actually passed a search term.
	 */
	readonly settings?: WarehouseQuerySettings | ((payload: Payload) => WarehouseQuerySettings | undefined)

	/**
	 * Edge cache policy, or `undefined` for deliberately uncached.
	 *
	 * Required-but-nullable on purpose. This is the field that turns ~50 silent
	 * opt-outs into ~50 reviewed decisions, and it only works if omitting it
	 * fails to compile.
	 *
	 * Be careful raising a TTL on anything live-tailing: a stale entry there is a
	 * user-visible correctness bug that presents as "the dashboard is frozen".
	 *
	 * May be a function of the payload and the current time. `spanDetail` needs
	 * that: a trace that finished long ago is immutable and can be cached hard,
	 * while one still receiving spans must not be — so its TTL is computed from
	 * the requested end time against now. `nowMs` is supplied by the runner from
	 * the Effect `Clock` rather than read here, so it stays testable.
	 */
	readonly cache:
		| DirectRouteCachePolicyInput
		| undefined
		| ((payload: Payload, nowMs: number) => DirectRouteCachePolicyInput | undefined)

	/**
	 * Resolve the backend's skip-index capabilities and hand them to `compile`.
	 *
	 * Off by default because it is not free: on BYO ClickHouse it costs a live
	 * `system.*` probe (measured p50 262ms), and only queries that can actually
	 * exploit bloom/tokenbf indices get anything back for it. Managed backends
	 * answer from a static snapshot, so for them it is free.
	 *
	 * Set it on the queries the executor already treats as capability-aware —
	 * log and trace list/search shapes, whose `attributeIndexMode` and
	 * `bodySearchMode` decide whether the emitted SQL can use an index at all.
	 * Declaring it changes the SQL those queries emit, so the SQL baseline moves
	 * with the change.
	 */
	readonly capabilityAware?: boolean

	/**
	 * Build the compiled query from the request payload.
	 *
	 * `orgId` is passed separately rather than read off the payload because it
	 * comes from the authenticated tenant, never from user input — every query
	 * must filter `OrgId`, and that guarantee should not depend on a client
	 * sending the right value.
	 *
	 * `capabilities` is the backend's index support. It is the BASELINE (all
	 * indices assumed absent) unless the def sets `capabilityAware`, so a query
	 * that ignores the argument keeps emitting exactly the SQL it did before.
	 */
	readonly compile: (
		payload: Payload,
		orgId: string,
		capabilities: WarehouseCapabilities,
	) => CompiledQuery<Row>
}

/**
 * Identity helper that pins `Payload`/`Row` from the `compile` function while
 * still checking the object against `QueryDef`.
 *
 * Without it, annotating an entry as `QueryDef<SomePayload, SomeRow>` forces you
 * to restate the row type that `CH.compile` already knows, and those two drift.
 */
export const defineQuery = <Payload, Row>(def: QueryDef<Payload, Row>): QueryDef<Payload, Row> => def

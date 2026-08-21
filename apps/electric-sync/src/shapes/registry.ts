// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { Schema } from "effect"

/**
 * The server-pinned shape whitelist and the predicates over it.
 *
 * This module is the *policy* half of the proxy: what a client is allowed to ask
 * for. It is pure data plus total functions, so every rule here is unit-testable
 * without a runtime — which is the point, since these definitions are the tenant
 * and secret-column boundary.
 */

// Every shape is additionally org-scoped by `ElectricClient`; `extraWhere` narrows
// the synced rows further and `columns` restricts which columns Electric streams to
// the browser (drop encrypted secrets / large jsonb blobs — the client never needs
// them, and they must not leave the server). Both are immutable — changing either is
// a new shape name + full re-sync, so version the name if it must ever change. When
// `columns` is set it MUST include the table's primary-key column(s) (Electric
// requires the PK in the projection).
//
// Every table listed here MUST also be a member of `electric_publication_default`
// (packages/db/drizzle/0009 + later publication migrations) — Electric runs with
// ELECTRIC_MANUAL_TABLE_PUBLISHING=true and will not publish a table itself, so a
// shape over an unpublished table never receives changes. The reverse also holds:
// a published table with no shape here (and no client collection) is pure
// replication cost, so drop it from the publication instead of leaving it. That
// is why the errors vertical (error_issues / actors / open_error_incidents) and
// scrape_target_checks are gone — see 0022_electric_publication_prune.
const SUBSCRIPTIONS = {
	dashboards: { table: "dashboards" },
	alert_rules: { table: "alert_rules" },
	alert_rule_states: { table: "alert_rule_states" },
	alert_incidents: { table: "alert_incidents" },
	// API key hashes and agent metadata are authentication material/internal
	// configuration and must never reach the browser. The dashboard needs only
	// the safe display fields below; `id` + `org_id` are required for identity
	// and tenant scoping.
	api_keys: {
		table: "api_keys",
		columns: [
			"id",
			"org_id",
			"name",
			"description",
			"key_prefix",
			"revoked",
			"revoked_at",
			"last_used_at",
			"expires_at",
			"scopes",
			"kind",
			"created_at",
			"created_by",
			"created_by_email",
		],
	},
	// `config_json` holds only public config (summary / channel label / hazel
	// metadata); the encrypted webhook secrets live in separate `secret_*` columns
	// that MUST NOT reach the browser, so the projection drops them (and the
	// unused `created_by`/`updated_by`). The PK `id` is required in the projection.
	alert_destinations: {
		table: "alert_destinations",
		columns: [
			"id",
			"org_id",
			"name",
			"type",
			"enabled",
			"config_json",
			"last_tested_at",
			"last_test_error",
			"created_at",
			"updated_at",
		],
	},
	// The two investigation shapes are `scoped`: org alone is too wide here. An org
	// accumulates investigations forever and a browser only ever renders one, so an
	// org-wide shape would stream the entire history (and every lane of every run)
	// to read a single page. The scope column is pinned here; only its *value*
	// comes from the client, and only as positional `$2`.
	//
	// The projection drops what the v2 wire already withholds — the planner's
	// `plan_json`, the lens lanes' `evidence_json` / `hypothesis_json` /
	// `mechanism` / `self_doubt`, and the workflow bookkeeping. Nothing renders
	// them, and they are the largest columns on both tables.
	investigation: {
		table: "investigations",
		scope: "id",
		columns: [
			"id",
			"org_id",
			"status",
			"seeded_by",
			"subject_json",
			"snapshot_json",
			"report_json",
			"severity",
			"confidence",
			"model",
			"input_tokens",
			"output_tokens",
			"error",
			"fanout_state",
			"fanout_size",
			// The lane rows are filtered to the current attempt client-side, exactly
			// as InvestigationService does — a straggler from a previous attempt must
			// not appear beside the run that superseded it.
			"fanout_attempt",
			"validator_note",
			"validator_elapsed_ms",
			"created_by",
			"created_at",
			"started_at",
			"diagnosed_at",
			"updated_at",
		],
	},
	investigation_lens_runs: {
		table: "investigation_lens_runs",
		scope: "investigation_id",
		columns: [
			"id",
			"org_id",
			"investigation_id",
			"lens_id",
			"attempt",
			"ordinal",
			"status",
			"verdict",
			"claim",
			"reason",
			"progress_note",
			"confidence",
			"tool_count",
			"elapsed_ms",
			"lens_name",
			"lens_question",
			"priority",
			"deadline_hit",
			// Not on the v2 wire, and the reason a synced lane can do something a
			// polled one could not: with the instant a lane started, a running lane's
			// elapsed can tick locally instead of waiting for the next `elapsed_ms`.
			"started_at",
		],
	},
} as const satisfies Record<string, SubscriptionDefinition>

export interface SubscriptionDefinition {
	readonly table: string
	readonly extraWhere?: string
	readonly columns?: ReadonlyArray<string>
	/**
	 * Column this shape is narrowed to a single value of, on top of the org scope.
	 * The column name is pinned here; the client supplies only the value, via the
	 * `scope` query param, bound positionally as `$2`.
	 */
	readonly scope?: string
}

export type SubscriptionName = keyof typeof SUBSCRIPTIONS

/**
 * The whitelist widened to one uniform record type.
 *
 * `SHAPES` is `as const` so each entry keeps its literal type, which is what makes
 * `ShapeName` exact — but it also means the union of its values has no property in
 * common, and reading an optional field off it does not typecheck. Keying this view
 * by `ShapeName` rather than `string` is what makes `lookupShape` total: the index
 * is already proven to be a member, so there is nothing to assert away.
 */
const SUBSCRIPTION_DEFS: Record<SubscriptionName, SubscriptionDefinition> = SUBSCRIPTIONS satisfies Record<
	SubscriptionName,
	SubscriptionDefinition
>

/** Every whitelisted shape, so tests can assert invariants across the whole set. */
export const SUBSCRIPTION_NAMES = Object.keys(SUBSCRIPTIONS) as ReadonlyArray<SubscriptionName>

/**
 * The shape selector as a schema, so the whitelist is a literal union rather than
 * a lookup against an object — which is also what makes prototype keys
 * (`toString`, `constructor`) non-members by construction instead of by a guard
 * someone has to remember to write.
 */
export const SubscriptionNameSchema: Schema.Literals<ReadonlyArray<SubscriptionName>> =
	Schema.Literals(SUBSCRIPTION_NAMES)

export const isSubscriptionName: (value: unknown) => value is SubscriptionName =
	Schema.is(SubscriptionNameSchema)

/** The pinned definition for a shape. Total — `ShapeName` is proof of membership. */
export const lookupSubscription = (subscription: SubscriptionName): SubscriptionDefinition =>
	SUBSCRIPTION_DEFS[subscription]

/** The column a shape narrows to a single client-supplied value, or null if it is org-wide. */
export const subscriptionScopeColumn = (subscription: SubscriptionName): string | null =>
	lookupSubscription(subscription).scope ?? null

/**
 * Whether a client-supplied scope value is acceptable.
 *
 * The value is bound positionally (`$2`), so this is not an injection guard —
 * it is a shape guard. An empty or absurd value would pin the shape to something
 * that matches nothing while still opening a replication stream, and Electric
 * would hold a shape handle per distinct value; bounding the length bounds how
 * many a caller can mint. Our ids are prefixed ULIDs / UUIDs, comfortably inside
 * this.
 */
export const ScopeValue: Schema.String = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const isValidScopeValue: (value: unknown) => value is string = Schema.is(ScopeValue)

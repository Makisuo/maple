import { Schema } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

/**
 * Dashboard props, authored in the v2 wire shape (snake_case, exactly as
 * documented at `/v2/docs`). `widgets`, `variables`, and `time_range` are
 * passed through verbatim.
 */
export interface DashboardProps {
	/** Dashboard name (unique-ish label shown in the UI). */
	name: string
	description?: string | null
	tags?: string[]
	/** e.g. `{ type: "relative", value: "12h" }`. */
	time_range?: Record<string, unknown>
	widgets?: Array<Record<string, unknown>>
	variables?: Array<Record<string, unknown>>
}

export type Dashboard = Resource<
	"Maple.Dashboard",
	DashboardProps,
	{
		/** The `dash_…` public ID. */
		dashboardId: string
		name: string
	},
	never,
	Providers
>

/**
 * A Maple dashboard managed through the public v2 API.
 *
 * @example
 * ```typescript
 * const dash = yield* Maple.Dashboard("service-health", {
 *   name: "Service health",
 *   widgets: [...],
 * })
 * ```
 */
export const Dashboard = Resource<Dashboard>("Maple.Dashboard")

/** Decode just the wire fields the provider stores/compares. */
const WireDashboard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	tags: Schema.Array(Schema.String),
	time_range: Schema.Record(Schema.String, Schema.Unknown),
	widgets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	variables: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeWireDashboard = Schema.decodeUnknownEffect(WireDashboard)

/** The request body for create/update: exactly the props the user set. */
const desiredBody = (props: DashboardProps) => ({
	name: props.name,
	...(props.description !== undefined ? { description: props.description } : {}),
	...(props.tags !== undefined ? { tags: props.tags } : {}),
	...(props.time_range !== undefined ? { time_range: props.time_range } : {}),
	...(props.widgets !== undefined ? { widgets: props.widgets } : {}),
	...(props.variables !== undefined ? { variables: props.variables } : {}),
})

/** Compare only the fields the user declared against the observed wire object. */
const drifted = (props: DashboardProps, observed: Schema.Schema.Type<typeof WireDashboard>): boolean => {
	const body = desiredBody(props) as Record<string, unknown>
	return Object.keys(body).some(
		(key) => !deepEqual(body[key], (observed as unknown as Record<string, unknown>)[key], { stripNullish: true }),
	)
}

const toAttributes = (observed: Schema.Schema.Type<typeof WireDashboard>) => ({
	dashboardId: observed.id,
	name: observed.name,
})

export const DashboardProvider = () =>
	Provider.effect(
		Dashboard,
		Effect.gen(function* () {
			const api = yield* MapleApi
			return {
				stables: ["dashboardId" as const],
				diff: Effect.fn(function* ({ news, olds }) {
					if (!isResolved(news)) return undefined
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["dashboardId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, output }) {
					// Observe — re-fetch by id; recover from out-of-band deletes.
					let observed: Schema.Schema.Type<typeof WireDashboard> | undefined
					if (output?.dashboardId) {
						const fetched = yield* api
							.get(`/v2/dashboards/${output.dashboardId}`)
							.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
						if (fetched !== undefined) observed = yield* decodeWireDashboard(fetched)
					}

					// Ensure — create if missing.
					if (observed === undefined) {
						const created = yield* api.post("/v2/dashboards", desiredBody(news))
						observed = yield* decodeWireDashboard(created)
					} else if (drifted(news, observed)) {
						// Sync — PATCH only when the declared fields drift.
						const updated = yield* api.patch(`/v2/dashboards/${observed.id}`, desiredBody(news))
						observed = yield* decodeWireDashboard(updated)
					}

					return toAttributes(observed)
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/dashboards/${output.dashboardId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.void))
				}),
				read: Effect.fn(function* ({ output }) {
					if (!output?.dashboardId) return undefined
					const fetched = yield* api
						.get(`/v2/dashboards/${output.dashboardId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
					if (fetched === undefined) return undefined
					return toAttributes(yield* decodeWireDashboard(fetched))
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/dashboards")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireDashboard(item), toAttributes),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _dashboardCreateBody = desiredBody

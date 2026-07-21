import { Schema } from "effect"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

/** A write-only channel secret: plain string or `Redacted` (recommended). */
type SecretInput = string | Redacted.Redacted<string>

interface DestinationBaseProps {
	/** Human-readable label for the destination. */
	name: string
	/** Whether the destination starts enabled. Defaults to `true`. */
	enabled?: boolean
}

/**
 * Alert destination props, discriminated on `type` — mirrors the v2
 * `POST /v2/alerts/destinations` body. Channel secrets are write-only:
 * the API never returns them, so drift on secret fields is detected from
 * prop changes only.
 */
export type AlertDestinationProps =
	| (DestinationBaseProps & { type: "slack"; webhook_url: SecretInput; channel_label?: string })
	| (DestinationBaseProps & { type: "pagerduty"; integration_key: SecretInput })
	| (DestinationBaseProps & { type: "webhook"; url: string; signing_secret?: SecretInput })
	| (DestinationBaseProps & { type: "hazel"; webhook_url: SecretInput; signing_secret?: SecretInput })
	| (DestinationBaseProps & { type: "discord"; webhook_url: SecretInput })
	| (DestinationBaseProps & { type: "email"; member_user_ids: string[] })

export type AlertDestination = Resource<
	"Maple.AlertDestination",
	AlertDestinationProps,
	{
		/** The `dest_…` public ID — reference it from `Maple.AlertRule` `destination_ids`. */
		destinationId: string
		name: string
		type: string
		enabled: boolean
	},
	never,
	Providers
>

/**
 * A notification channel (Slack, PagerDuty, webhook, Hazel, Discord, or
 * workspace-member email) that `Maple.AlertRule`s deliver to.
 *
 * @example
 * ```typescript
 * const slack = yield* Maple.AlertDestination("oncall", {
 *   type: "slack",
 *   name: "On-call Slack",
 *   webhook_url: Redacted.make(process.env.SLACK_WEBHOOK_URL!),
 *   channel_label: "#incidents",
 * })
 * ```
 */
export const AlertDestination = Resource<AlertDestination>("Maple.AlertDestination")

const WireDestination = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	enabled: Schema.Boolean,
	channel_label: Schema.NullOr(Schema.String),
})
const decodeWireDestination = Schema.decodeUnknownEffect(WireDestination)

const unwrap = (value: SecretInput): string => (Redacted.isRedacted(value) ? Redacted.value(value) : value)

/** The create/update body: all declared props, secrets unwrapped. */
const desiredBody = (props: AlertDestinationProps): Record<string, unknown> => {
	const body: Record<string, unknown> = { type: props.type, name: props.name }
	if (props.enabled !== undefined) body.enabled = props.enabled
	switch (props.type) {
		case "slack":
			body.webhook_url = unwrap(props.webhook_url)
			if (props.channel_label !== undefined) body.channel_label = props.channel_label
			break
		case "pagerduty":
			body.integration_key = unwrap(props.integration_key)
			break
		case "webhook":
			body.url = props.url
			if (props.signing_secret !== undefined) body.signing_secret = unwrap(props.signing_secret)
			break
		case "hazel":
			body.webhook_url = unwrap(props.webhook_url)
			if (props.signing_secret !== undefined) body.signing_secret = unwrap(props.signing_secret)
			break
		case "discord":
			body.webhook_url = unwrap(props.webhook_url)
			break
		case "email":
			body.member_user_ids = props.member_user_ids
			break
	}
	return body
}

/**
 * Observable drift only — secrets are write-only, so the server can never
 * disagree with them; they change via prop changes (caught in `diff`).
 */
const drifted = (props: AlertDestinationProps, observed: Schema.Schema.Type<typeof WireDestination>): boolean =>
	props.name !== observed.name ||
	(props.enabled ?? true) !== observed.enabled ||
	(props.type === "slack" &&
		props.channel_label !== undefined &&
		props.channel_label !== (observed.channel_label ?? undefined))

const toAttributes = (observed: Schema.Schema.Type<typeof WireDestination>) => ({
	destinationId: observed.id,
	name: observed.name,
	type: observed.type,
	enabled: observed.enabled,
})

export const AlertDestinationProvider = () =>
	Provider.effect(
		AlertDestination,
		Effect.gen(function* () {
			const api = yield* MapleApi
			return {
				stables: ["destinationId" as const],
				diff: Effect.fn(function* ({ news, olds, output }) {
					if (!isResolved(news)) return undefined
					// `type` is immutable server-side — changing it replaces the destination.
					if ((output?.type ?? olds?.type) !== undefined && news.type !== (output?.type ?? olds?.type)) {
						return { action: "replace" } as const
					}
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["destinationId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, olds, output }) {
					// Observe — re-fetch by id; recover from out-of-band deletes.
					let observed: Schema.Schema.Type<typeof WireDestination> | undefined
					if (output?.destinationId) {
						const fetched = yield* api
							.get(`/v2/alerts/destinations/${output.destinationId}`)
							.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
						if (fetched !== undefined) observed = yield* decodeWireDestination(fetched)
					}

					// Ensure — create if missing.
					if (observed === undefined) {
						const created = yield* api.post("/v2/alerts/destinations", desiredBody(news))
						observed = yield* decodeWireDestination(created)
					} else if (
						drifted(news, observed) ||
						olds === undefined ||
						!deepEqual(olds, news, { stripNullish: true })
					) {
						// Sync — PATCH when observable fields drift OR declared props changed
						// (write-only secrets can only be pushed, never compared).
						const updated = yield* api.patch(
							`/v2/alerts/destinations/${observed.id}`,
							desiredBody(news),
						)
						observed = yield* decodeWireDestination(updated)
					}

					return toAttributes(observed)
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/alerts/destinations/${output.destinationId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.void))
				}),
				read: Effect.fn(function* ({ output }) {
					if (!output?.destinationId) return undefined
					const fetched = yield* api
						.get(`/v2/alerts/destinations/${output.destinationId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
					if (fetched === undefined) return undefined
					return toAttributes(yield* decodeWireDestination(fetched))
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/alerts/destinations")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireDestination(item), toAttributes),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _alertDestinationCreateBody = desiredBody

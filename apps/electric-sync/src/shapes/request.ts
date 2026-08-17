import { Result, Schema } from "effect"
import { SyncRequestInvalid } from "../errors"
import {
	ScopeValue,
	type SubscriptionName,
	SubscriptionNameSchema,
	subscriptionScopeColumn,
} from "./registry"

/**
 * A shape request that has passed validation: the shape is whitelisted, and if it
 * is a scoped shape it carries an acceptable scope value. `scopeValue` is present
 * only for scoped shapes — a stray `?scope=` on an org-wide shape is dropped here
 * rather than travelling on as something a later caller might act on.
 */
/**
 * A WHERE predicate and the value it binds, as one thing.
 *
 * The column is always ours (the org column, or a shape's pinned `scope`); only
 * the value ever comes from the client, and it travels positionally. Keeping the
 * pair together is what stops a predicate from being emitted without its binding,
 * or numbered differently from it.
 */
export interface ScopeBinding {
	readonly column: string
	readonly value: string
}

export interface SyncRequest {
	readonly shape: SubscriptionName
	/**
	 * The resolved scope binding, or `null` for an org-wide shape. Resolved here
	 * and nowhere else: a scoped shape can only reach a caller *with* its column
	 * and value paired up, so "scoped shape, no value" — which used to fall
	 * through to the org-wide stream the scope exists to avoid — is now
	 * unrepresentable rather than guarded against.
	 */
	readonly scope: ScopeBinding | null
	/** The raw client query, from which only the reserved cursor params are forwarded. */
	readonly clientParams: URLSearchParams
}

/**
 * The two Maple-owned query params, as schemas. Everything else on the query
 * belongs to Electric and is forwarded (or dropped) untouched, so this is the
 * whole of what the client can *say* to us.
 */
const SubscriptionNameResult = Schema.decodeUnknownResult(SubscriptionNameSchema)
const ScopeParam = Schema.decodeUnknownResult(ScopeValue)

/**
 * The one place a client's query string becomes a `SyncRequest`. Total and pure —
 * every rejection is a `Result` failure, not a thrown error or a response — so the
 * request-validation surface is testable without a runtime or an HTTP handler.
 */
export const decodeSyncRequest = (
	clientParams: URLSearchParams,
): Result.Result<SyncRequest, SyncRequestInvalid> =>
	SubscriptionNameResult(clientParams.get("shape")).pipe(
		Result.mapError(() => new SyncRequestInvalid({ message: "Unknown or missing shape" })),
		Result.flatMap((subscription): Result.Result<SyncRequest, SyncRequestInvalid> => {
			const column = subscriptionScopeColumn(subscription)
			if (column === null) {
				return Result.succeed({ shape: subscription, scope: null, clientParams })
			}

			// A scoped shape without its scope is a rejection rather than a default —
			// and because the column is bound to the value right here, there is no
			// later point at which one could exist without the other.
			return ScopeParam(clientParams.get("scope")).pipe(
				Result.mapError(
					() => new SyncRequestInvalid({ message: `Shape ${subscription} requires a scope` }),
				),
				Result.map((value) => ({ shape: subscription, scope: { column, value }, clientParams })),
			)
		}),
	)

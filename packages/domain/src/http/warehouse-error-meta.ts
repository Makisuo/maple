// Warehouse error presentation metadata — the single source of truth.
//
// The nine warehouse error classes used to be re-enumerated by hand in five
// places (two MCP tables, the alerts v2 map, AlertsService's failure
// categories, and the web's error formatter), so adding a tag meant five
// lockstep edits across five packages and any missed arm silently changed
// where the error went. This module owns everything derivable per tag:
//
// - `WAREHOUSE_ERROR_TAGS` / `warehouseErrorStatus` are DERIVED from the error
//   classes themselves (same annotation-reading as `anticipated-errors.ts`).
// - Public HTTP codes/titles live on the error classes themselves.
// - `presentWarehouseError` is the shared human-facing formatter. It is
//   structural (works on wire-decoded objects, not just class instances) so
//   the web app can feed it errors that crossed the HTTP boundary.
//
// Imports nothing beyond `./warehouse-errors` (which imports only `effect`
// Schema), so web/CLI bundles stay driver-free.

import type { WarehouseError } from "./warehouse-errors"
import { warehouseHttpErrors } from "./warehouse-errors"
import {
	publicHttpErrorPolicyFor,
	type PublicHttpErrorPolicy,
	type PublicHttpErrorStatus,
	type PublicTaggedError,
} from "./error-policy"

export type WarehouseErrorTag = WarehouseError["_tag"]

const prop = (obj: unknown, key: string): unknown =>
	(typeof obj === "object" || typeof obj === "function") && obj !== null && key in obj
		? (obj as Record<string, unknown>)[key]
		: undefined

const readTag = (value: unknown): string | undefined => {
	const literal = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	return typeof literal === "string" ? literal : undefined
}

const readHttpStatus = (value: unknown): number | undefined => {
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	return typeof status === "number" ? status : undefined
}

/** Every warehouse error tag, derived from the classes — never hand-listed. */
export const WAREHOUSE_ERROR_TAGS: ReadonlyArray<WarehouseErrorTag> = warehouseHttpErrors.map((cls) => {
	const tag = readTag(cls)
	if (tag === undefined) throw new Error("warehouse error class without a _tag literal")
	return tag as WarehouseErrorTag
})

/** `httpApiStatus` per tag, derived from the class annotations. */
export const warehouseErrorStatus: ReadonlyMap<WarehouseErrorTag, number> = new Map(
	warehouseHttpErrors.map((cls) => {
		const tag = readTag(cls) as WarehouseErrorTag
		const status = readHttpStatus(cls)
		if (status === undefined) throw new Error(`warehouse error ${tag} without httpApiStatus`)
		return [tag, status] as const
	}),
)

const warehouseErrorClassByTag = new Map<WarehouseErrorTag, Function>(
	warehouseHttpErrors.map((cls) => [readTag(cls) as WarehouseErrorTag, cls]),
)

type WarehousePublicError = PublicTaggedError & WarehouseErrorLike

const warehouseErrorPolicy = (
	error: WarehouseErrorLike,
): PublicHttpErrorPolicy<WarehousePublicError, PublicHttpErrorStatus> => {
	const errorClass = warehouseErrorClassByTag.get(error._tag)
	if (errorClass === undefined) throw new Error(`Unknown warehouse error tag: ${error._tag}`)
	return publicHttpErrorPolicyFor<WarehousePublicError>(errorClass)
}

const resolvePolicyValue = <Value>(
	value: Value | ((error: WarehousePublicError) => Value),
	error: WarehouseErrorLike,
): Value =>
	typeof value === "function"
		? (value as (error: WarehousePublicError) => Value)({ message: error.message ?? "", ...error })
		: value

/** Stable machine-readable code owned by the warehouse error class. */
export const warehouseErrorCode = (error: WarehouseErrorLike): string => {
	const policy = warehouseErrorPolicy(error)
	return resolvePolicyValue(policy.code, error)
}

/** Public title owned by the warehouse error class. */
export const warehouseErrorTitle = (error: WarehouseErrorLike): string => {
	const policy = warehouseErrorPolicy(error)
	return resolvePolicyValue(policy.title, error)
}

/**
 * Strip HTML error pages / whitespace noise out of an upstream error message.
 * Shared by the classifier (query-engine) and the web formatter — this used to
 * be two byte-identical copies.
 */
export const cleanErrorMessage = (raw: string): string => {
	let cleaned = raw
	const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
	if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
	cleaned = cleaned
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
	return cleaned || raw.slice(0, 200)
}

/** Sniff an HTTP status embedded in an upstream error message. */
export const extractUpstreamStatus = (message: string): number | undefined => {
	const match = message.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)
	if (match) return Number(match[1])
	const titleMatch = message.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)
	if (titleMatch) return Number(titleMatch[1])
	return undefined
}

const QUOTA_DESCRIPTIONS: Record<string, string> = {
	max_execution_time: "Query exceeded the 30s execution limit. Narrow the time range or add filters.",
	max_memory_usage: "Query exceeded the memory limit. Add filters or reduce cardinality.",
	max_threads: "Query exceeded the thread limit. Try a smaller scan.",
}

const authDescription = (upstreamStatus: number | undefined): string =>
	upstreamStatus === 403
		? "The configured database credentials are missing required permissions."
		: "The configured database credentials are invalid or expired. Update them in settings."

/**
 * A warehouse error as seen AFTER crossing the HTTP boundary: a plain decoded
 * object, not necessarily a class instance. Every field beyond `_tag` is
 * optional so the presenter never trusts the wire.
 */
export interface WarehouseErrorLike {
	readonly _tag: WarehouseErrorTag
	readonly message?: string
	readonly setting?: string
	readonly upstreamStatus?: number
	readonly kind?: string
}

export interface PresentedWarehouseError {
	readonly title: string
	readonly description: string
}

/**
 * Shared human-facing copy per warehouse error. Structural on purpose — the
 * web formatter feeds it wire-decoded objects, the MCP layer feeds it class
 * instances; both get identical copy.
 */
export const presentWarehouseError = (error: WarehouseErrorLike): PresentedWarehouseError => {
	const title = warehouseErrorTitle(error)
	const message = error.message !== undefined ? cleanErrorMessage(error.message) : undefined
	switch (error._tag) {
		case "@maple/http/errors/WarehouseQuotaExceededError": {
			const setting = error.setting ?? "limit"
			return {
				title,
				description:
					QUOTA_DESCRIPTIONS[setting] ??
					`Query exceeded the ${setting} limit. Narrow the time range or add filters.`,
			}
		}
		case "@maple/http/errors/WarehouseAuthError":
			return { title, description: authDescription(error.upstreamStatus) }
		case "@maple/http/errors/WarehouseUpstreamError":
			return {
				title,
				description:
					error.upstreamStatus !== undefined
						? `The query backend returned ${error.upstreamStatus}. Retry in a few seconds.`
						: "The query backend is unreachable. Retry in a few seconds.",
			}
		case "@maple/http/errors/WarehouseConfigError":
			return { title, description: message ?? "Database is not configured correctly." }
		case "@maple/http/errors/WarehouseClientError":
			return { title, description: message ?? "Database response could not be decoded." }
		case "@maple/http/errors/WarehouseSchemaDriftError": {
			// `kind: "decode"` = the CLUSTER answered fine but the rows failed
			// Maple's own row schema — schema apply cannot fix that, so don't
			// advise it (the advice sent people chasing infra symptoms).
			if (error.kind === "decode") {
				return {
					title: "Query results did not match what Maple expected",
					description: `${message ?? "The database answered with rows Maple could not decode."} This is likely a Maple bug, not a problem with your cluster.`,
				}
			}
			return {
				title,
				description: `${message ?? "A column Maple expects is missing from the cluster."} Run schema apply from your ClickHouse settings.`,
			}
		}
		case "@maple/http/errors/WarehouseMalformedQueryError":
			// Maple generated SQL the database refused to plan. Nothing the user
			// can do — do not send them to their database settings.
			return {
				title,
				description:
					"Maple built a query its own database rejected. This is our fault, not a problem with your data or your cluster — we have been alerted.",
			}
		case "@maple/http/errors/WarehouseValidationError":
			return { title, description: message ?? "The query was rejected before running." }
		case "@maple/http/errors/WarehouseQueryError": {
			// Generic SQL/query failure. Some transient failures still arrive with
			// only a status code embedded in the message (e.g. a 5xx HTML body), so
			// sniff it to surface those nicely.
			const text = message ?? "Database query failed"
			const upstreamStatus = extractUpstreamStatus(text)
			if (upstreamStatus === 401 || upstreamStatus === 403) {
				return {
					title: warehouseErrorTitle({ _tag: "@maple/http/errors/WarehouseAuthError" }),
					description: authDescription(upstreamStatus),
				}
			}
			if (upstreamStatus !== undefined && upstreamStatus >= 500 && upstreamStatus < 600) {
				return {
					title: warehouseErrorTitle({ _tag: "@maple/http/errors/WarehouseUpstreamError" }),
					description: `The query backend returned ${upstreamStatus}. Retry in a few seconds.`,
				}
			}
			return { title, description: text }
		}
	}
}

export const isWarehouseErrorTag = (tag: string): tag is WarehouseErrorTag =>
	warehouseErrorClassByTag.has(tag as WarehouseErrorTag)

/**
 * Presentation with the raw upstream message REDACTED — every description
 * falls back to Maple-authored copy. Public API envelopes use this: ClickHouse
 * diagnostics can echo generated SQL and internal identifiers, and the v2
 * surface deliberately never forwards them (the web app, talking to its own
 * org's data, uses `presentWarehouseError` directly).
 */
export const presentWarehouseErrorPublic = (error: WarehouseErrorLike): PresentedWarehouseError => {
	const { message: _message, ...rest } = error
	return presentWarehouseError(rest)
}

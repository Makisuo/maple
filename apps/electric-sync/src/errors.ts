import { Match, Schema } from "effect"
import { syncResponseHeaders } from "./routes/headers"

/**
 * Every way a shape request can end other than success, as plain data.
 *
 * Each error carries a `message`: the SDK reads a span's `status.message` off the
 * failure's `Error.message`, so without it a span could say only *that* the
 * request failed. The message is the internal, diagnostic one — what goes back to
 * the client is decided by `errorResponse` below, which is deliberately terser.
 *
 * Nothing here carries an `HttpServerResponse`. Response construction belongs at
 * the route boundary; keeping these as data is what lets a test assert the failure
 * itself rather than inferring it from a status code.
 */

export class SyncRequestInvalid extends Schema.TaggedError<SyncRequestInvalid>()(
	"@maple/electric-sync/ShapeRequestInvalid",
	{ message: Schema.String },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("@maple/electric-sync/Unauthorized", {
	message: Schema.String,
}) {}

/**
 * Sync is disabled for this deploy. Two distinct causes share the 503 — no
 * `ELECTRIC_URL` at all (expected on self-hosted) versus a deploy that
 * half-configured Cloud credentials (a misconfiguration to chase down) — so
 * `reason` keeps them apart in traces.
 */
export class ElectricNotConfigured extends Schema.TaggedError<ElectricNotConfigured>()(
	"@maple/electric-sync/ElectricNotConfigured",
	{
		message: Schema.String,
		reason: Schema.Literals(["missing_url", "incoherent_credentials"]),
	},
) {}

/** The upstream request never produced a response (transport failure or timeout). */
export class ElectricUpstreamUnreachable extends Schema.TaggedError<ElectricUpstreamUnreachable>()(
	"@maple/electric-sync/ElectricUpstreamUnreachable",
	{ message: Schema.String },
) {}

/** Electric answered, but with a 5xx. Its status and body are passed through. */
export class ElectricUpstreamError extends Schema.TaggedError<ElectricUpstreamError>()(
	"@maple/electric-sync/ElectricUpstreamError",
	{
		message: Schema.String,
		status: Schema.Number,
		body: Schema.String,
		headers: Schema.Record(Schema.String, Schema.String),
	},
) {}

export type SyncError =
	| SyncRequestInvalid
	| Unauthorized
	| ElectricNotConfigured
	| ElectricUpstreamUnreachable
	| ElectricUpstreamError

export interface ErrorResponse {
	readonly status: number
	readonly body: string
	readonly headers: Record<string, string>
	/** Value for the span's `error.type` attribute. */
	readonly errorType: string
}

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" }

/**
 * The single error → HTTP mapping. Pure, so the whole failure surface can be
 * asserted in one table-driven test rather than inferred from six router tests.
 *
 * Client-facing bodies stay terse on purpose: the error's own `message` carries
 * the diagnosis into the span, and a 503 caused by a half-configured Electric
 * source is not something to describe to a browser.
 */
export const errorResponse: (error: SyncError) => ErrorResponse = Match.type<SyncError>().pipe(
	Match.tag(
		"@maple/electric-sync/ShapeRequestInvalid",
		(error): ErrorResponse => ({
			status: 400,
			body: error.message,
			headers: TEXT_HEADERS,
			errorType: "ShapeRequestInvalid",
		}),
	),
	Match.tag(
		"@maple/electric-sync/Unauthorized",
		(): ErrorResponse => ({
			status: 401,
			body: "Unauthorized",
			headers: TEXT_HEADERS,
			errorType: "Unauthorized",
		}),
	),
	Match.tag(
		"@maple/electric-sync/ElectricNotConfigured",
		(error): ErrorResponse => ({
			status: 503,
			body: "Electric sync is not configured",
			headers: TEXT_HEADERS,
			errorType: Match.value(error.reason).pipe(
				Match.when("missing_url", () => "ElectricConfigUnavailable"),
				Match.when("incoherent_credentials", () => "ElectricConfigIncoherent"),
				Match.exhaustive,
			),
		}),
	),
	Match.tag(
		"@maple/electric-sync/ElectricUpstreamUnreachable",
		(): ErrorResponse => ({
			status: 502,
			body: "Electric upstream unreachable",
			headers: TEXT_HEADERS,
			errorType: "ElectricUpstreamUnavailable",
		}),
	),
	Match.tag(
		"@maple/electric-sync/ElectricUpstreamError",
		// Electric's own status and body go back verbatim, through the same
		// cache-isolation header rewrite a 2xx gets — a 5xx is still an org-scoped
		// response and must not be shared-cached either.
		(error): ErrorResponse => ({
			status: error.status,
			body: error.body,
			headers: syncResponseHeaders(error.headers),
			errorType: "ElectricUpstreamError",
		}),
	),
	// A new error variant is a type error here rather than a silent `undefined`
	// response — the reason this mapping is exhaustive by construction.
	Match.exhaustive,
)

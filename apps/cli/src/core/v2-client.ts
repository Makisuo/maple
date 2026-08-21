// The CLI's remote backend: a typed client over Maple's public v2 API.
//
// Remote mode used to impersonate a warehouse — it POSTed a pipe name and
// params to `/api/tinybird/query` and let the server compile the query. That
// seam is gone. v2 is a resource API, so there is no generic
// `query(pipeName, params)` to implement; each operation names the resource it
// wants and maps the response into the shape the renderers already consume
// (see `operations.ts`).
//
// Auth is the token `maple auth login` already stores: a `maple_ak_…` API key
// minted with `kind: "standard"` and no scope restriction, which
// `ApiAuthorizationV2Layer` accepts across every `/v2` family.

import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { WarehouseClientError, WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import type { Range } from "./time"

/**
 * `Range` carries ClickHouse-style `YYYY-MM-DD HH:mm:ss` UTC, which the v2
 * `Timestamp` schema rejects — it requires ISO-8601 with an explicit UTC
 * designator. Convert at the boundary rather than widening the wire schema.
 */
export const toV2Timestamp = (clickhouseUtc: string): string => `${clickhouseUtc.replace(" ", "T")}.000Z`

export const toV2Window = (range: Range): { start_time: string; end_time: string } => ({
	start_time: toV2Timestamp(range.startTime),
	end_time: toV2Timestamp(range.endTime),
})

export type MapleV2Client = Effect.Success<ReturnType<typeof makeV2Client>>

export const makeV2Client = (apiUrl: string, token: string) =>
	HttpApiClient.make(MapleApiV2, {
		baseUrl: apiUrl.replace(/\/$/, ""),
		transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
	})

/**
 * Remote mode reaches the warehouse through v2 resources, so anything v2 does
 * not expose has no remote implementation. Rather than emit a partial or
 * silently wrong answer, these fail with the reason — the same posture
 * `rawQuery` takes for raw SQL.
 *
 * Each gap here is a missing v2 capability, not a CLI limitation; see
 * `docs/http-api-migration.md`.
 */
export const unsupportedInRemote = (pipeName: string, reason: string) =>
	Effect.fail(
		new WarehouseClientError({
			message: `\`${pipeName}\` is only available in local mode: ${reason} Run this command against a local store with --local.`,
			pipeName,
		}),
	)

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) return error.message
	if (typeof error === "object" && error !== null && "message" in error) {
		return String((error as { message: unknown }).message)
	}
	return String(error)
}

/**
 * Collapse a v2 client failure into the warehouse error tags the CLI already
 * handles. `bin.ts` dispatches on those tags to decide what is an expected
 * outcome and what closes the root span as an error, so remote failures must
 * arrive tagged rather than as bare decode/transport values.
 */
export const toWarehouseError = (pipeName: string) => (error: unknown) =>
	error instanceof WarehouseClientError || error instanceof WarehouseQueryError
		? error
		: new WarehouseQueryError({ message: errorMessage(error), pipeName, cause: error })

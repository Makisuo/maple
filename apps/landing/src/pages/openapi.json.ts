/**
 * `/openapi.json` — the Maple public API's OpenAPI 3.1 document, published on
 * the website so it sits at the conventional path next to `llms.txt`.
 *
 * Derived at build time from the same `MapleApiV2` contract the API serves at
 * `api.maple.dev/openapi.json`, so the two cannot disagree for a given commit.
 * `servers` in the document already names `https://api.maple.dev`.
 */
import { MapleApiV2 } from "@maple/domain/http/v2"
import type { APIRoute } from "astro"
import { OpenApi } from "effect/unstable/httpapi"

export const openApiDocument = () => OpenApi.fromApi(MapleApiV2)

export const GET: APIRoute = () =>
	new Response(`${JSON.stringify(openApiDocument())}\n`, {
		headers: { "Content-Type": "application/json; charset=utf-8" },
	})

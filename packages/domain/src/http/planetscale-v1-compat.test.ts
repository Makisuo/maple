import { describe, expect, it } from "@effect/vitest"
import { OpenApi } from "effect/unstable/httpapi"
import { MapleApi } from "./api"

/**
 * The v1 PlanetScale endpoints have no consumer left in this repo — the
 * dashboard moved to `/v2/integrations/planetscale` — but customers may still
 * be calling them. That combination is exactly how a surface gets deleted by
 * accident: nothing fails, no test goes red, and the breakage shows up as a
 * support ticket.
 *
 * So freeze it. This asserts the ten operations still exist at their exact
 * paths and methods, and that each is marked deprecated so `/docs` steers new
 * integrations to v2. Removing one is then a deliberate edit to this file,
 * which is the point — do that once the access logs show no external traffic.
 */
const spec = OpenApi.fromApi(MapleApi) as unknown as Record<string, any>

const PLANETSCALE_V1_SURFACE = [
	["get", "/api/integrations/planetscale/status"],
	["post", "/api/integrations/planetscale/start"],
	["get", "/api/integrations/planetscale/organizations"],
	["post", "/api/integrations/planetscale/select-organization"],
	["post", "/api/integrations/planetscale/metrics-token"],
	["delete", "/api/integrations/planetscale"],
	["get", "/api/integrations/planetscale/databases"],
	["get", "/api/integrations/planetscale/webhook-config"],
	["post", "/api/integrations/planetscale/query-insights"],
	["post", "/api/integrations/planetscale/events"],
] as const

describe("v1 PlanetScale compatibility surface", () => {
	it("still serves every v1 operation, superseded by /v2 but not removed", () => {
		const missing = PLANETSCALE_V1_SURFACE.filter(
			([method, path]) => spec.paths?.[path]?.[method] === undefined,
		).map(([method, path]) => `${method.toUpperCase()} ${path}`)
		expect(missing).toEqual([])
	})

	it("marks every v1 operation deprecated so /docs points integrators at v2", () => {
		const notDeprecated = PLANETSCALE_V1_SURFACE.filter(
			([method, path]) => spec.paths?.[path]?.[method]?.deprecated !== true,
		).map(([method, path]) => `${method.toUpperCase()} ${path}`)
		expect(notDeprecated).toEqual([])
	})

	it("keeps the v1 wire format camelCase — reshaping it would break live callers", () => {
		const status = spec.paths["/api/integrations/planetscale/status"].get
		const schemaRef = status.responses["200"].content["application/json"].schema
		const name = String(schemaRef.$ref).split("/").pop()!
		const properties = Object.keys(spec.components.schemas[name].properties)
		// The v2 twin spells these `pending_org_selection` / `metrics_auth` /
		// `scrape_target`. v1 must not drift toward it.
		expect(properties).toContain("pendingOrgSelection")
		expect(properties).toContain("metricsAuth")
		expect(properties).toContain("scrapeTarget")
	})
})

import { describe, expect, it } from "vitest"
import type { ServiceEndpoint } from "@/api/warehouse/service-endpoints"
import { groupEndpoints, leafLabel, looksLikeProbe, looksUnrouted } from "./endpoint-grouping"

const endpoint = (method: string, route: string, calls = 100, errors = 0): ServiceEndpoint => ({
	spanName: `${method} ${route}`,
	method,
	route,
	spanCount: calls,
	estimatedSpanCount: calls,
	errorCount: errors,
	estimatedErrorCount: errors,
	errorRate: calls > 0 ? errors / calls : 0,
	avgDurationMs: 10,
	p50DurationMs: 10,
	p95DurationMs: 20,
	p99DurationMs: 30,
	sparkline: [],
})

const stems = (groups: ReturnType<typeof groupEndpoints>) =>
	groups.map((g) => (g.kind === "stem" ? g.stem : g.kind))

describe("groupEndpoints", () => {
	it("uses the longest common prefix, not the first branch point", () => {
		const groups = groupEndpoints([
			endpoint("GET", "/v2/organizations/{orgId}/subscriptions"),
			endpoint("DELETE", "/v2/organizations/{orgId}/subscriptions/{id}"),
			endpoint("GET", "/v2/organizations/{orgId}/subscriptions/{id}/checkout"),
			endpoint("POST", "/v2/webhooks/stripe"),
			endpoint("POST", "/v2/webhooks/github"),
		])
		// NOT "/v2" or "/v2/organizations" — both are legal prefixes and useless ones.
		expect(stems(groups)).toEqual(["/v2/organizations/{orgId}/subscriptions", "/v2/webhooks"])
	})

	it("never makes a group of one", () => {
		const groups = groupEndpoints([
			endpoint("POST", "/v2/webhooks/stripe"),
			endpoint("POST", "/v2/webhooks/github"),
			endpoint("GET", "/v2/status"),
		])
		expect(stems(groups)).toEqual(["/v2/webhooks", "ungrouped"])
		expect(groups[1]?.endpoints.map((e) => e.route)).toEqual(["/v2/status"])
	})

	it("emits no headers at all for a flat API", () => {
		const groups = groupEndpoints([
			endpoint("GET", "/healthz"),
			endpoint("POST", "/graphql"),
			endpoint("GET", "/metrics"),
		])
		expect(stems(groups)).toEqual(["ungrouped"])
		expect(groups[0]?.endpoints).toHaveLength(3)
	})

	it("collapses routes carrying raw identifiers into one unrouted group", () => {
		const groups = groupEndpoints([
			endpoint("GET", "/v2/webhooks/stripe"),
			endpoint("GET", "/v2/webhooks/github"),
			endpoint("GET", "/v2/orgs/8f3ad91c2b/subscriptions/9c21ff"),
			endpoint("GET", "/v2/orgs/4de7b02a11/subscriptions/1a0bcd"),
		])
		expect(stems(groups)).toEqual(["/v2/webhooks", "unrouted"])
		expect(groups[1]?.endpoints).toHaveLength(2)
	})

	it("sorts groups by combined traffic and leaves by their own", () => {
		const groups = groupEndpoints([
			endpoint("POST", "/v2/webhooks/stripe", 900),
			endpoint("POST", "/v2/webhooks/github", 900),
			endpoint("GET", "/v2/subs/{id}", 100),
			endpoint("GET", "/v2/subs/{id}/checkout", 700),
		])
		expect(stems(groups)).toEqual(["/v2/webhooks", "/v2/subs/{id}"])
		expect(groups[1]?.endpoints.map((e) => e.route)).toEqual(["/v2/subs/{id}/checkout", "/v2/subs/{id}"])
	})

	it("sorts by path when asked", () => {
		const groups = groupEndpoints(
			[
				endpoint("POST", "/v2/webhooks/stripe", 900),
				endpoint("POST", "/v2/webhooks/github", 900),
				endpoint("GET", "/v2/subs/{id}", 100),
				endpoint("GET", "/v2/subs/{id}/checkout", 700),
			],
			"path",
		)
		expect(stems(groups)).toEqual(["/v2/subs/{id}", "/v2/webhooks"])
		expect(groups[1]?.endpoints.map((e) => e.route)).toEqual([
			"/v2/webhooks/github",
			"/v2/webhooks/stripe",
		])
	})

	it("aggregates a group's totals, taking the worst p99 rather than an average", () => {
		const a = { ...endpoint("GET", "/v2/subs/{id}", 100, 10), p99DurationMs: 50 }
		const b = { ...endpoint("GET", "/v2/subs/{id}/checkout", 300, 2), p99DurationMs: 900 }
		const [group] = groupEndpoints([a, b])
		expect(group?.totals.estimatedSpanCount).toBe(400)
		expect(group?.totals.errorRate).toBeCloseTo(12 / 400)
		expect(group?.totals.p99DurationMs).toBe(900)
	})

	it("handles a single endpoint without inventing a group", () => {
		expect(stems(groupEndpoints([endpoint("GET", "/healthz")]))).toEqual(["ungrouped"])
	})

	it("returns nothing for no endpoints", () => {
		expect(groupEndpoints([])).toEqual([])
	})
})

describe("looksUnrouted", () => {
	it.each([
		["/v2/orgs/8f3ad91c2b/subs", true],
		["/users/12345", true],
		["/s/550e8400-e29b-41d4-a716-446655440000", true],
		["/files/aGVsbG9Xb3JsZFRoaXNJc0xvbmc", true],
		["/v2/organizations/{orgId}/subscriptions", false],
		["/users/:id/profile", false],
		["/healthz", false],
		["/v2/webhooks/stripe", false],
	])("%s → %s", (route, expected) => {
		expect(looksUnrouted(route)).toBe(expected)
	})
})

describe("leafLabel", () => {
	it("dims the remainder and keeps the distinguishing segment", () => {
		expect(leafLabel("/v2/subs/{id}/checkout", "/v2/subs")).toEqual({
			head: "…/{id}",
			tail: "/checkout",
		})
	})

	it("reads an endpoint that is the stem itself as an index", () => {
		expect(leafLabel("/v2/subs", "/v2/subs")).toEqual({ head: "", tail: "(index)" })
	})

	it("keeps the whole route when there is no stem", () => {
		expect(leafLabel("/healthz", "")).toEqual({ head: "", tail: "/healthz" })
	})
})

describe("looksLikeProbe", () => {
	it.each([
		["/wp-login.php", true],
		["/wp-admin/setup-config.php", true],
		["/.env", true],
		["/.git/config", true],
		["/phpmyadmin/index.php", true],
		["/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", true],
		["/cgi-bin/test.sh", true],
		["/backup.sql", true],
		["/config.bak", true],
		["/../../etc/passwd", true],
		["/%2e%2e/%2e%2e/etc/passwd", true],
		["http://example.com/proxy-check", true],
	])("flags %s", (route, expected) => {
		expect(looksLikeProbe(route)).toBe(expected)
	})

	it.each([
		["/v2/organizations/{orgId}/subscriptions", false],
		["/healthz", false],
		["/graphql", false],
		// Legitimately served by real services — must never be swept up.
		["/.well-known/acme-challenge/{token}", false],
		["/.well-known/security.txt", false],
		["/actuator/health", false],
		["/api/config.json", false],
		["/feed.xml", false],
		["/v2/keys", false],
	])("leaves %s alone", (route, expected) => {
		expect(looksLikeProbe(route)).toBe(expected)
	})
})

describe("scanner noise", () => {
	it("collapses probes into their own group, apart from unrouted", () => {
		const groups = groupEndpoints([
			endpoint("GET", "/v2/webhooks/stripe", 900),
			endpoint("GET", "/v2/webhooks/github", 900),
			endpoint("GET", "/v2/orgs/8f3ad91c2b/subs", 5),
			endpoint("GET", "/wp-login.php", 40),
			endpoint("POST", "/.env", 22),
		])
		expect(stems(groups)).toEqual(["/v2/webhooks", "unrouted", "probes"])
		expect(groups[2]?.endpoints.map((e) => e.route)).toEqual(["/wp-login.php", "/.env"])
	})

	it("keeps probes out of the stem trie entirely", () => {
		// Without the partition, three /admin.php-style paths would form their own
		// stem group and read as a real part of the API.
		const groups = groupEndpoints([
			endpoint("GET", "/v2/subs/{id}"),
			endpoint("GET", "/v2/subs/{id}/checkout"),
			endpoint("GET", "/admin/login.php"),
			endpoint("GET", "/admin/config.php"),
		])
		expect(stems(groups)).toEqual(["/v2/subs/{id}", "probes"])
	})
})

import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import { classifyAction, routingContextFromInvestigation } from "./action-target"

const context = { serviceName: "checkout-api", scope: "checkout-api", issueId: "iss_9dK1" }

const kindOf = (action: string) => classifyAction(action, context).kind

describe("classifyAction", () => {
	it("reads the shape of work off the verb", () => {
		expect(kindOf("Roll back deploy 8f21c")).toBe("rollback")
		expect(kindOf("Create a dashboard for pool utilisation")).toBe("dashboard")
		expect(kindOf("Inspect the slow spans on the checkout path")).toBe("traces")
		expect(kindOf("Search the logs around 14:02")).toBe("logs")
		expect(kindOf("Patch the HTTP client to restore keepAlive")).toBe("code")
	})

	/**
	 * The ordering is the whole trick. "Roll back the deploy and alert on pool
	 * saturation" is a rollback that mentions an alert — matching on "alert" first
	 * would stamp a bell on the one action that ships code.
	 */
	it("takes the most specific verb when a sentence names several", () => {
		expect(kindOf("Roll back deploy 8f21c, then alert on pool_active / pool_max")).toBe("rollback")
		expect(kindOf("Raise the pool ceiling 128 → 512 and add a dashboard")).toBe("dashboard")
	})

	/**
	 * "Check telemetry ingestion … whether root spans are emitted" is an
	 * instrumentation job that happens to say "spans", so the specific setup words
	 * outrank the generic telemetry nouns. The bare word "service" does not — it
	 * appears in half the sentences the report writes.
	 */
	it("prefers instrumentation over the noun it happens to mention", () => {
		expect(kindOf("Check telemetry ingestion and SDK/exporter config, including root spans")).toBe(
			"service",
		)
		expect(kindOf("Inspect the slow spans on the checkout-api service")).toBe("traces")
	})

	it("matches whole words, not substrings", () => {
		// "catalogue" contains "log"; "released" would match a `release` prefix.
		expect(kindOf("Rebuild the service catalogue entry")).not.toBe("logs")
	})

	/** Every row keeps its icon lane occupied, so the column still reads as a column. */
	it("falls back to a generic task rather than to nothing", () => {
		expect(kindOf("Ask the payments team what changed")).toBe("task")
	})

	/**
	 * Kind and destination are separate answers: there is no deploys page in Maple,
	 * and a rollback losing its icon along with its link would be the wrong trade.
	 */
	it("classifies an action it cannot route", () => {
		const rollback = classifyAction("Roll back deploy 8f21c", context)
		expect(rollback).toMatchObject({ kind: "rollback", target: null })
	})

	it("still routes an action whose kind has no page of its own", () => {
		expect(classifyAction("Roll back the deploy, then alert on saturation", context)).toMatchObject({
			kind: "rollback",
			target: { href: "/alerts" },
		})
	})

	it("routes to the issue only when there is one", () => {
		expect(classifyAction("Triage the error issue", context).target).toMatchObject({
			href: "/errors/issues/iss_9dK1",
		})
		expect(classifyAction("Triage the error issue", {}).target).toBeNull()
	})

	/**
	 * A scope is only a service link when it could *be* a service name. Freeform
	 * investigations title their own scope ("checkout latency spike"), and
	 * `/services/checkout%20latency%20spike` is a 404 dressed up as a call to action.
	 */
	it("does not route a multi-word scope to a service page", () => {
		expect(
			classifyAction("Check the service exporter config", { scope: "checkout latency spike" }).target,
		).toBeNull()
	})
})

describe("routingContextFromInvestigation", () => {
	it("carries the issue id of an incident subject", () => {
		const investigation = {
			subject: {
				type: "incident",
				incident_kind: "error",
				incident_id: "einc_1",
				issue_id: "iss_9dK1",
			},
			snapshot: { scope: "checkout-api", serviceName: "checkout-api" },
		} as never as V2Investigation
		expect(routingContextFromInvestigation(investigation)).toEqual({
			serviceName: "checkout-api",
			scope: "checkout-api",
			issueId: "iss_9dK1",
		})
	})

	/** A freeform investigation has no incident behind it, so no issue to open. */
	it("has no issue id for a freeform subject", () => {
		const freeform = {
			subject: { type: "freeform" },
			snapshot: { scope: "checkout latency spike" },
		} as never as V2Investigation
		expect(routingContextFromInvestigation(freeform).issueId).toBeNull()
		expect(
			classifyAction("Triage the error issue", routingContextFromInvestigation(freeform)).target,
		).toBeNull()
	})
})

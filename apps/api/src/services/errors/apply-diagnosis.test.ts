import { describe, expect, it } from "vitest"
import { Option } from "effect"

import { deterministicInvestigationEventId, subjectTypeOf } from "./apply-diagnosis"

/**
 * `subjectTypeOf` is the only thing standing between a routine post-merge
 * verification and a re-ranked severity on an issue a human already triaged, so
 * what matters here is which way it fails.
 *
 * `None` is the DANGEROUS answer: it means "not a verification", and the
 * severity write proceeds. So the cases worth pinning are the ones where the
 * stored row is ugly but the discriminator is still plainly readable.
 */
describe("subjectTypeOf", () => {
	it("reads the discriminator off a complete stored subject", () => {
		// The real shape, excess keys and all — a decode that rejected these would
		// answer None for every genuine verification.
		expect(
			subjectTypeOf({
				type: "fix_verification",
				issueId: "3f1c8a2e-9b4d-4f7a-8c1e-2d5b6a7c8e90",
				verificationId: "3f1c8a2e-9b4d-4f7a-8c1e-2d5b6a7c8e91",
				pullRequestUrl: "https://github.com/MapleTechLabs/maple/pull/612",
				baselineVersions: ["v1", "v2"],
				mergedAt: "2026-08-24T00:00:00.000Z",
			}),
		).toEqual(Option.some("fix_verification"))
	})

	it("still recognizes a verification whose other fields drifted", () => {
		// An older-shaped or partially-written row is still plainly a verification.
		// Reading the whole `InvestigationSubject` here would answer None and let
		// the severity write through — this is why only the discriminator is read.
		expect(subjectTypeOf({ type: "fix_verification" })).toEqual(Option.some("fix_verification"))
		expect(subjectTypeOf({ type: "fix_verification", issueId: 12345, mergedAt: null })).toEqual(
			Option.some("fix_verification"),
		)
	})

	it("reads the other subject types", () => {
		expect(subjectTypeOf({ type: "incident", incidentKind: "error", incidentId: "i" })).toEqual(
			Option.some("incident"),
		)
		expect(subjectTypeOf({ type: "freeform", title: "t", prompt: "p", contextRefs: [] })).toEqual(
			Option.some("freeform"),
		)
	})

	it("is None for a value that carries no readable discriminator", () => {
		for (const unreadable of [null, undefined, 42, "nope", [], {}, { type: 7 }, { type: "" }]) {
			expect(Option.isNone(subjectTypeOf(unreadable)), JSON.stringify(unreadable) ?? "undefined").toBe(
				true,
			)
		}
	})

	it("is None for a subject type this build does not know", () => {
		// A future fourth subject type reaching an older deploy. None is correct —
		// it is not a verification as far as this build is concerned — and the
		// literal set is derived from the union so the two cannot drift apart.
		expect(Option.isNone(subjectTypeOf({ type: "brand_new_subject" }))).toBe(true)
	})
})

describe("deterministicInvestigationEventId", () => {
	it("is stable for an investigation, so a retried write hits the same primary key", () => {
		const first = deterministicInvestigationEventId("inv-1")
		expect(deterministicInvestigationEventId("inv-1")).toBe(first)
		expect(deterministicInvestigationEventId("inv-2")).not.toBe(first)
	})

	it("is a well-formed v5-shaped UUID", () => {
		// The id is decoded through the branded `ErrorIssueEventId` at the call
		// site, whose `isUUID()` check rejects an out-of-range version nibble.
		expect(deterministicInvestigationEventId("inv-1")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		)
	})
})

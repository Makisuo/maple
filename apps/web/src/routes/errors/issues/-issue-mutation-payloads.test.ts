import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	ErrorIssueClaimRequest,
	ErrorIssueCommentRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueTransitionRequest,
} from "@maple/domain/http"
import {
	makeIssueClaimPayload,
	makeIssueCommentPayload,
	makeIssueReleasePayload,
	makeIssueTransitionPayload,
} from "./-issue-mutation-payloads"

describe("error issue mutation payloads", () => {
	it.each([
		[ErrorIssueTransitionRequest, makeIssueTransitionPayload("done")],
		[ErrorIssueClaimRequest, makeIssueClaimPayload()],
		[ErrorIssueReleaseRequest, makeIssueReleasePayload()],
		[ErrorIssueCommentRequest, makeIssueCommentPayload("Investigating the regression")],
	] as const)("constructs an encodable %s", (Request, payload) => {
		expect(payload).toBeInstanceOf(Request)
		expect(() => Schema.encodeUnknownSync(Request)(payload)).not.toThrow()
	})
})

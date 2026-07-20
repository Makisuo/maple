import {
	ErrorIssueClaimRequest,
	ErrorIssueCommentRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueTransitionRequest,
	type WorkflowState,
} from "@maple/domain/http"

export const makeIssueTransitionPayload = (toState: WorkflowState): ErrorIssueTransitionRequest =>
	new ErrorIssueTransitionRequest({ toState })

export const makeIssueClaimPayload = (): ErrorIssueClaimRequest => new ErrorIssueClaimRequest({})

export const makeIssueReleasePayload = (): ErrorIssueReleaseRequest => new ErrorIssueReleaseRequest({})

export const makeIssueCommentPayload = (body: string): ErrorIssueCommentRequest =>
	new ErrorIssueCommentRequest({ body })

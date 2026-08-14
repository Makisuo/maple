import { Schema } from "effect"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4 * 1024))
const CanonicalUrl = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(2 * 1024),
	Schema.isPattern(/^https?:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/),
)
const CommentUrl = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(2 * 1024),
	Schema.isPattern(/^https?:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?(?:#[^?#\s]+)?$/),
)
const PositiveInt64 = Schema.String.check(Schema.isMaxLength(20), Schema.isPattern(/^[1-9][0-9]*$/))
const NonNegativeInt64 = Schema.String.check(Schema.isMaxLength(20), Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
const Revision = Schema.String.check(
	Schema.isMinLength(6),
	Schema.isMaxLength(64),
	Schema.isPattern(/^[0-9a-f]+$/i),
)
const Token = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(64),
	Schema.isPattern(/^[a-z][a-z0-9_]*$/),
)
const CommentExcerpt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

const Project = Schema.Struct({
	id: PositiveInt64,
	path: Text,
	oldPath: Schema.optionalKey(Text),
})

const Actor = Schema.Struct({
	id: Schema.optionalKey(PositiveInt64),
	name: Schema.optionalKey(Text),
	username: Schema.optionalKey(Text),
})

const Common = {
	sourceEvent: Token,
	actor: Schema.optionalKey(Actor),
	result: Schema.optionalKey(Text),
	serviceName: Schema.optionalKey(Text),
} as const

const Issue = Schema.Struct({
	id: Schema.optionalKey(PositiveInt64),
	iid: PositiveInt64,
	type: Token,
	title: Schema.optionalKey(Text),
	url: Schema.optionalKey(CanonicalUrl),
	state: Schema.optionalKey(Token),
	labels: Schema.optionalKey(
		Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
			Schema.isMaxLength(50),
		),
	),
})

const MergeRequest = Schema.Struct({
	iid: PositiveInt64,
	title: Text,
	url: CanonicalUrl,
	sourceBranch: Schema.optionalKey(Text),
	targetBranch: Schema.optionalKey(Text),
	commit: Schema.optionalKey(Revision),
	reviewState: Schema.optionalKey(Token),
})

const Comment = Schema.Struct({
	id: PositiveInt64,
	kind: Schema.optionalKey(Schema.Literals(["comment", "review"])),
	excerpt: CommentExcerpt,
	url: CommentUrl,
	system: Schema.optionalKey(Schema.Boolean),
})

export const GitLabIssueCreatedDataSchema = Schema.Struct({
	project: Schema.Struct({ id: Schema.optionalKey(Schema.String), path: Schema.String }),
	issue: Schema.Struct({
		id: Schema.optionalKey(Schema.String),
		iid: Schema.String,
		title: Schema.optionalKey(Schema.String),
		url: Schema.optionalKey(Schema.String),
	}),
	actor: Schema.optionalKey(
		Schema.Struct({ id: Schema.optionalKey(Schema.String), username: Schema.optionalKey(Schema.String) }),
	),
	serviceName: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.Unknown),
}).annotate({ identifier: "GitLabIssueCreatedDataV1" })

export const GitLabProjectLifecycleDataSchema = Schema.Struct({
	project: Project,
	action: Schema.Literals([
		"created",
		"destroyed",
		"renamed",
		"transferred",
		"updated",
		"archived",
		"unarchived",
		"deletion_requested",
	]),
	...Common,
}).annotate({ identifier: "GitLabProjectLifecycleDataV1" })

export const GitLabIssueLifecycleDataSchema = Schema.Struct({
	project: Project,
	issue: Schema.Struct({
		id: Schema.optionalKey(PositiveInt64),
		iid: PositiveInt64,
		type: Token,
		title: Schema.optionalKey(Text),
		url: Schema.optionalKey(CanonicalUrl),
		state: Schema.optionalKey(Token),
		labels: Schema.optionalKey(
			Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
				Schema.isMaxLength(50),
			),
		),
		action: Schema.Literals(["open", "update", "close", "reopen"]),
	}),
	...Common,
}).annotate({ identifier: "GitLabIssueLifecycleDataV1" })

export const GitLabIssueCommentDataSchema = Schema.Struct({
	project: Project,
	issue: Issue,
	comment: Comment,
	...Common,
}).annotate({ identifier: "GitLabIssueCommentDataV1" })

export const GitLabMergeRequestLifecycleDataSchema = Schema.Struct({
	project: Project,
	mergeRequest: Schema.Struct({
		iid: PositiveInt64,
		title: Text,
		url: CanonicalUrl,
		sourceBranch: Schema.optionalKey(Text),
		targetBranch: Schema.optionalKey(Text),
		commit: Schema.optionalKey(Revision),
		reviewState: Schema.optionalKey(Token),
		action: Schema.Literals(["open", "update", "close", "reopen", "merge", "review"]),
	}),
	...Common,
}).annotate({ identifier: "GitLabMergeRequestLifecycleDataV1" })

export const GitLabMergeRequestCommentDataSchema = Schema.Struct({
	project: Project,
	mergeRequest: MergeRequest,
	comment: Comment,
	...Common,
}).annotate({ identifier: "GitLabMergeRequestCommentDataV1" })

const PipelineCommon = {
	id: PositiveInt64,
	iid: Schema.optionalKey(PositiveInt64),
	mergeRequestIid: Schema.optionalKey(PositiveInt64),
	name: Schema.optionalKey(Text),
	source: Schema.optionalKey(Text),
	detailedStatus: Schema.optionalKey(Text),
	url: CanonicalUrl,
	ref: Schema.optionalKey(Text),
	sha: Schema.optionalKey(Revision),
	durationMs: Schema.optionalKey(NonNegativeInt64),
	queuedDurationMs: Schema.optionalKey(NonNegativeInt64),
	stageCount: Schema.optionalKey(NonNegativeInt64),
} as const

const FailedJob = Schema.Struct({
	id: PositiveInt64,
	name: Text,
	stage: Schema.optionalKey(Text),
	status: Schema.Literal("failed"),
	url: Schema.optionalKey(CanonicalUrl),
})

const Pipeline = Schema.Union([
	Schema.Struct({
		...PipelineCommon,
		status: Schema.Literal("failed"),
		failedJobCount: NonNegativeInt64,
		failedJobsTruncated: Schema.Boolean,
		failedJobs: Schema.Array(FailedJob).check(Schema.isMaxLength(20)),
	}),
	Schema.Struct({
		...PipelineCommon,
		status: Schema.Literals(["success", "canceled", "skipped"]),
	}),
])

export const GitLabPipelineCompletedDataSchema = Schema.Struct({
	project: Project,
	pipeline: Pipeline,
	...Common,
}).annotate({ identifier: "GitLabPipelineCompletedDataV1" })

export const GitLabDeploymentLifecycleDataSchema = Schema.Struct({
	project: Project,
	deployment: Schema.Struct({
		id: PositiveInt64,
		environment: Text,
		status: Schema.Literals(["running", "success", "failed", "canceled", "blocked", "manual"]),
		revision: Revision,
		url: CanonicalUrl,
	}),
	...Common,
}).annotate({ identifier: "GitLabDeploymentLifecycleDataV1" })

export const GitLabJobLifecycleDataSchema = Schema.Struct({
	project: Project,
	job: Schema.Struct({
		id: PositiveInt64,
		name: Text,
		status: Schema.Literals([
			"created",
			"pending",
			"preparing",
			"waiting_for_resource",
			"running",
			"success",
			"failed",
			"canceled",
			"skipped",
			"manual",
			"scheduled",
		]),
		stage: Schema.optionalKey(Text),
		url: Schema.optionalKey(CanonicalUrl),
		pipelineId: Schema.optionalKey(PositiveInt64),
		ref: Schema.optionalKey(Text),
		revision: Schema.optionalKey(Revision),
		durationMs: Schema.optionalKey(NonNegativeInt64),
		allowFailure: Schema.optionalKey(Schema.Boolean),
	}),
	...Common,
}).annotate({ identifier: "GitLabJobLifecycleDataV1" })

export const GitLabRefLifecycleDataSchema = Schema.Struct({
	project: Project,
	ref: Schema.Struct({
		type: Schema.Literals(["branch", "tag"]),
		action: Schema.Literals(["create", "update", "delete"]),
		name: Text,
		before: Revision,
		after: Revision,
		url: Schema.optionalKey(CanonicalUrl),
		commitCount: Schema.optionalKey(NonNegativeInt64),
	}),
	...Common,
}).annotate({ identifier: "GitLabRefLifecycleDataV1" })

export const GitLabReleaseLifecycleDataSchema = Schema.Struct({
	project: Project,
	release: Schema.Struct({
		id: Schema.optionalKey(PositiveInt64),
		tag: Text,
		action: Schema.Literals(["create", "update", "delete"]),
		name: Schema.optionalKey(Text),
		url: Schema.optionalKey(CanonicalUrl),
	}),
	...Common,
}).annotate({ identifier: "GitLabReleaseLifecycleDataV1" })

export type GitLabIssueCreatedData = Schema.Schema.Type<typeof GitLabIssueCreatedDataSchema>
export type GitLabProjectLifecycleData = Schema.Schema.Type<typeof GitLabProjectLifecycleDataSchema>
export type GitLabIssueLifecycleData = Schema.Schema.Type<typeof GitLabIssueLifecycleDataSchema>
export type GitLabIssueCommentData = Schema.Schema.Type<typeof GitLabIssueCommentDataSchema>
export type GitLabMergeRequestLifecycleData = Schema.Schema.Type<typeof GitLabMergeRequestLifecycleDataSchema>
export type GitLabMergeRequestCommentData = Schema.Schema.Type<typeof GitLabMergeRequestCommentDataSchema>
export type GitLabPipelineCompletedData = Schema.Schema.Type<typeof GitLabPipelineCompletedDataSchema>
export type GitLabDeploymentLifecycleData = Schema.Schema.Type<typeof GitLabDeploymentLifecycleDataSchema>
export type GitLabJobLifecycleData = Schema.Schema.Type<typeof GitLabJobLifecycleDataSchema>
export type GitLabRefLifecycleData = Schema.Schema.Type<typeof GitLabRefLifecycleDataSchema>
export type GitLabReleaseLifecycleData = Schema.Schema.Type<typeof GitLabReleaseLifecycleDataSchema>

export const GITLAB_DATA_SCHEMAS = [
	["urn:maple:event-schema:gitlab-issue-created:v1", GitLabIssueCreatedDataSchema],
	["urn:maple:event-schema:gitlab-project-lifecycle:v1", GitLabProjectLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-issue-lifecycle:v1", GitLabIssueLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-issue-comment:v1", GitLabIssueCommentDataSchema],
	["urn:maple:event-schema:gitlab-merge-request-lifecycle:v1", GitLabMergeRequestLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-merge-request-comment:v1", GitLabMergeRequestCommentDataSchema],
	["urn:maple:event-schema:gitlab-pipeline-completed:v1", GitLabPipelineCompletedDataSchema],
	["urn:maple:event-schema:gitlab-deployment-lifecycle:v1", GitLabDeploymentLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-job-lifecycle:v1", GitLabJobLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-ref-lifecycle:v1", GitLabRefLifecycleDataSchema],
	["urn:maple:event-schema:gitlab-release-lifecycle:v1", GitLabReleaseLifecycleDataSchema],
] as const

export const validateGitLabEventData = (dataSchema: string, candidate: unknown): unknown => {
	const entry = GITLAB_DATA_SCHEMAS.find(([id]) => id === dataSchema)
	if (entry === undefined) throw new Error(`unknown GitLab event data schema: ${dataSchema}`)
	return Schema.decodeUnknownSync(entry[1] as Schema.Codec<unknown, unknown>)(candidate)
}

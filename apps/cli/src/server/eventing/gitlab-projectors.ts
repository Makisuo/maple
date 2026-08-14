import {
	ProjectorRegistry,
	fieldKey,
	isJsonValue,
	type NormalizedSignal,
	type SignalScalar,
} from "@maple/eventing-core"

export interface GitLabIssueProjectorConfig {
	readonly includeBody: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const gitlabProjectorConfig = (value: unknown): GitLabIssueProjectorConfig => {
	if (!isRecord(value)) throw new Error("gitlab.issue.created projector config must be an object")
	const keys = Object.keys(value)
	if (keys.some((key) => key !== "includeBody"))
		throw new Error("gitlab.issue.created projector config contains an unknown field")
	if (value.includeBody !== undefined && typeof value.includeBody !== "boolean")
		throw new Error("gitlab.issue.created includeBody must be boolean")
	return { includeBody: value.includeBody === true }
}

const field = (signal: NormalizedSignal, namespace: "signal" | "resource" | "attribute", key: string) =>
	signal.fields.get(fieldKey({ namespace, key }))

const scalarString = (value: SignalScalar | undefined, label: string, required = false) => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab issue event is missing ${label}`)
		return undefined
	}
	if (value.type !== "string") throw new Error(`GitLab issue event ${label} must be a string`)
	return value.value
}

const scalarInt64 = (value: SignalScalar | undefined, label: string, required = false) => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab issue event is missing ${label}`)
		return undefined
	}
	if (value.type !== "int64") throw new Error(`GitLab issue event ${label} must be an int64`)
	return value.value
}

export const gitlabIssueCreatedProjector = {
	id: "gitlab.issue.created",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.issue.created.v1",
	dataSchema: "urn:maple:event-schema:gitlab-issue-created:v1",
	decodeConfig: gitlabProjectorConfig,
	project: (signal: NormalizedSignal, config: GitLabIssueProjectorConfig) => {
		const projectId = scalarInt64(field(signal, "attribute", "gitlab.project.id"), "gitlab.project.id")
		const projectPath = scalarString(
			field(signal, "attribute", "gitlab.project.path"),
			"gitlab.project.path",
			true,
		)!
		const issueId = scalarInt64(field(signal, "attribute", "gitlab.issue.id"), "gitlab.issue.id")
		const issueIid = scalarInt64(
			field(signal, "attribute", "gitlab.issue.iid"),
			"gitlab.issue.iid",
			true,
		)!
		const title = scalarString(field(signal, "attribute", "gitlab.issue.title"), "gitlab.issue.title")
		const url = scalarString(field(signal, "attribute", "gitlab.issue.url"), "gitlab.issue.url")
		const actorId = scalarInt64(field(signal, "attribute", "gitlab.user.id"), "gitlab.user.id")
		const actorUsername = scalarString(
			field(signal, "attribute", "gitlab.user.username"),
			"gitlab.user.username",
		)
		const serviceName = scalarString(field(signal, "resource", "service.name"), "service.name")
		const candidateBody =
			isRecord(signal.data) && isRecord(signal.data.record) ? signal.data.record.body : undefined
		const body = isJsonValue(candidateBody) ? candidateBody : undefined
		return {
			subject: `${projectPath}/issues/${issueIid}`,
			data: {
				project: {
					...(projectId === undefined ? {} : { id: projectId }),
					path: projectPath,
				},
				issue: {
					...(issueId === undefined ? {} : { id: issueId }),
					iid: issueIid,
					...(title === undefined ? {} : { title }),
					...(url === undefined ? {} : { url }),
				},
				...(actorId === undefined && actorUsername === undefined
					? {}
					: {
							actor: {
								...(actorId === undefined ? {} : { id: actorId }),
								...(actorUsername === undefined ? {} : { username: actorUsername }),
							},
						}),
				...(serviceName === undefined ? {} : { serviceName }),
				...(config.includeBody && body !== undefined ? { body } : {}),
			},
		}
	},
} as const

type GitLabProjectAction =
	| "created"
	| "destroyed"
	| "renamed"
	| "transferred"
	| "updated"
	| "archived"
	| "unarchived"
	| "deletion_requested"

const PROJECT_LIFECYCLE_ACTIONS: Readonly<Record<string, GitLabProjectAction>> = {
	project_create: "created",
	project_destroy: "destroyed",
	project_rename: "renamed",
	project_transfer: "transferred",
	project_update: "updated",
	project_archive: "archived",
	project_unarchive: "unarchived",
	project_deletion_request: "deletion_requested",
}

const TERMINAL_PIPELINE_STATUSES = new Set(["success", "failed", "canceled", "skipped"])
const ISSUE_LIFECYCLE_ACTIONS = {
	issue_open: "open",
	issue_update: "update",
	issue_close: "close",
	issue_reopen: "reopen",
} as const
const MERGE_REQUEST_LIFECYCLE_ACTIONS = {
	merge_request_open: "open",
	merge_request_update: "update",
	merge_request_close: "close",
	merge_request_reopen: "reopen",
	merge_request_merge: "merge",
	merge_request_review: "review",
} as const
const DEPLOYMENT_STATUSES = {
	deployment_running: "running",
	deployment_success: "success",
	deployment_failed: "failed",
	deployment_canceled: "canceled",
	deployment_blocked: "blocked",
	deployment_manual: "manual",
} as const
const JOB_STATUSES = new Set([
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
])
const RELEASE_ACTIONS = new Set(["create", "update", "delete"])
const MAX_PROJECTOR_TEXT_BYTES = 4 * 1024
const MAX_COMMENT_EXCERPT_BYTES = 1024
const MAX_CANONICAL_URL_BYTES = 2048
const MAX_FAILED_JOBS = 20
const MAX_ISSUE_LABELS = 50
const MAX_ISSUE_LABEL_BYTES = 256

const projectorString = (
	value: SignalScalar | undefined,
	label: string,
	required = false,
): string | undefined => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab projector is missing ${label}`)
		return undefined
	}
	if (value.type !== "string") throw new Error(`GitLab projector ${label} must be a string`)
	const text = value.value.trim()
	if (text.length === 0) throw new Error(`GitLab projector ${label} must not be blank`)
	if (Buffer.byteLength(text, "utf8") > MAX_PROJECTOR_TEXT_BYTES)
		throw new Error(`GitLab projector ${label} exceeds ${MAX_PROJECTOR_TEXT_BYTES} UTF-8 bytes`)
	return text
}

const projectorToken = (
	value: SignalScalar | undefined,
	label: string,
	required = false,
): string | undefined => {
	const token = projectorString(value, label, required)
	if (token !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(token))
		throw new Error(`GitLab projector ${label} must be a lowercase token`)
	return token
}

const projectorUrl = (
	value: SignalScalar | undefined,
	label: string,
	required = false,
	allowFragment = false,
): string | undefined => {
	const text = projectorString(value, label, required)
	if (text === undefined) return undefined
	if (Buffer.byteLength(text, "utf8") > MAX_CANONICAL_URL_BYTES)
		throw new Error(`GitLab projector ${label} exceeds ${MAX_CANONICAL_URL_BYTES} UTF-8 bytes`)
	let parsed: URL
	try {
		parsed = new URL(text)
	} catch {
		throw new Error(`GitLab projector ${label} must be an absolute URL`)
	}
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password)
		throw new Error(`GitLab projector ${label} must be an HTTP(S) URL without credentials`)
	if (parsed.search || (!allowFragment && parsed.hash))
		throw new Error(`GitLab projector ${label} must not contain a query or fragment`)
	return text
}

const projectorRevision = (
	value: SignalScalar | undefined,
	label: string,
	required = false,
): string | undefined => {
	const revision = projectorString(value, label, required)
	if (revision !== undefined && !/^[0-9a-f]{6,64}$/i.test(revision))
		throw new Error(`GitLab projector ${label} must be a hexadecimal revision`)
	return revision
}

const projectorBoolean = (value: SignalScalar | undefined, label: string): boolean | undefined => {
	if (value === undefined) return undefined
	if (value.type !== "boolean") throw new Error(`GitLab projector ${label} must be a boolean`)
	return value.value
}

const projectorExcerpt = (value: SignalScalar | undefined, label: string): string | undefined => {
	const source = projectorString(value, label)
	if (source === undefined) return undefined
	const excerpt = source
		.replace(/[\p{Cc}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
	if (excerpt.length === 0) throw new Error(`GitLab projector ${label} must not be blank after sanitizing`)
	if (Buffer.byteLength(excerpt, "utf8") > MAX_COMMENT_EXCERPT_BYTES)
		throw new Error(`GitLab projector ${label} exceeds ${MAX_COMMENT_EXCERPT_BYTES} UTF-8 bytes`)
	return excerpt
}

const projectorInt64 = (
	value: SignalScalar | undefined,
	label: string,
	required = false,
): string | undefined => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab projector is missing ${label}`)
		return undefined
	}
	if (value.type !== "int64") throw new Error(`GitLab projector ${label} must be an int64`)
	return value.value
}

const positiveProjectorInt64 = (value: SignalScalar | undefined, label: string): string => {
	const parsed = projectorInt64(value, label, true)!
	if (BigInt(parsed) <= 0n) throw new Error(`GitLab projector ${label} must be positive`)
	return parsed
}

const optionalPositiveProjectorInt64 = (
	value: SignalScalar | undefined,
	label: string,
): string | undefined => {
	const parsed = projectorInt64(value, label)
	if (parsed !== undefined && BigInt(parsed) <= 0n)
		throw new Error(`GitLab projector ${label} must be positive`)
	return parsed
}

const nonNegativeProjectorInt64 = (value: SignalScalar | undefined, label: string): string | undefined => {
	const parsed = projectorInt64(value, label)
	if (parsed !== undefined && BigInt(parsed) < 0n)
		throw new Error(`GitLab projector ${label} must not be negative`)
	return parsed
}

const eventName = (signal: NormalizedSignal): string =>
	projectorString(
		field(signal, "attribute", "event.name") ?? field(signal, "signal", "event.name"),
		"event.name",
		true,
	)!

const actor = (signal: NormalizedSignal) => {
	const id = optionalPositiveProjectorInt64(
		field(signal, "attribute", "gitlab.actor.id"),
		"gitlab.actor.id",
	)
	const name = projectorString(field(signal, "attribute", "gitlab.actor.name"), "gitlab.actor.name")
	const username = projectorString(
		field(signal, "attribute", "gitlab.actor.username"),
		"gitlab.actor.username",
	)
	if (name === undefined && username === undefined && id === undefined) return undefined
	return {
		...(id === undefined ? {} : { id }),
		...(name === undefined ? {} : { name }),
		...(username === undefined ? {} : { username }),
	}
}

const issue = (signal: NormalizedSignal) => {
	const id = optionalPositiveProjectorInt64(
		field(signal, "attribute", "gitlab.issue.id"),
		"gitlab.issue.id",
	)
	const iid = positiveProjectorInt64(field(signal, "attribute", "gitlab.issue.iid"), "gitlab.issue.iid")
	const title = projectorString(field(signal, "attribute", "gitlab.issue.title"), "gitlab.issue.title")
	const url = projectorUrl(field(signal, "attribute", "gitlab.issue.url"), "gitlab.issue.url")
	const state = projectorToken(field(signal, "attribute", "gitlab.issue.state"), "gitlab.issue.state")
	const labels = issueLabels(signal)
	return {
		...(id === undefined ? {} : { id }),
		iid,
		...(title === undefined ? {} : { title }),
		...(url === undefined ? {} : { url }),
		...(state === undefined ? {} : { state }),
		...(labels === undefined ? {} : { labels }),
	}
}

const mergeRequest = (signal: NormalizedSignal) => {
	const iid = positiveProjectorInt64(
		field(signal, "attribute", "gitlab.merge_request.iid"),
		"gitlab.merge_request.iid",
	)
	const title = projectorString(
		field(signal, "attribute", "gitlab.merge_request.title"),
		"gitlab.merge_request.title",
	)
	const url = projectorUrl(
		field(signal, "attribute", "gitlab.merge_request.url"),
		"gitlab.merge_request.url",
	)
	const sourceBranch = projectorString(
		field(signal, "attribute", "gitlab.merge_request.source_branch"),
		"gitlab.merge_request.source_branch",
	)
	const targetBranch = projectorString(
		field(signal, "attribute", "gitlab.merge_request.target_branch"),
		"gitlab.merge_request.target_branch",
	)
	const commit = projectorRevision(
		field(signal, "attribute", "gitlab.merge_request.commit"),
		"gitlab.merge_request.commit",
	)
	const reviewState = projectorToken(
		field(signal, "attribute", "gitlab.merge_request.review_state"),
		"gitlab.merge_request.review_state",
	)
	return {
		iid,
		...(title === undefined ? {} : { title }),
		...(url === undefined ? {} : { url }),
		...(sourceBranch === undefined ? {} : { sourceBranch }),
		...(targetBranch === undefined ? {} : { targetBranch }),
		...(commit === undefined ? {} : { commit }),
		...(reviewState === undefined ? {} : { reviewState }),
	}
}

const comment = (signal: NormalizedSignal, kind?: "comment" | "review") => {
	const id = positiveProjectorInt64(field(signal, "attribute", "gitlab.comment.id"), "gitlab.comment.id")
	const excerpt = projectorExcerpt(
		field(signal, "attribute", "gitlab.comment.excerpt"),
		"gitlab.comment.excerpt",
	)
	const url = projectorUrl(
		field(signal, "attribute", "gitlab.comment.url"),
		"gitlab.comment.url",
		false,
		true,
	)
	const system = projectorBoolean(
		field(signal, "attribute", "gitlab.comment.system"),
		"gitlab.comment.system",
	)
	return {
		id,
		...(kind === undefined ? {} : { kind }),
		...(excerpt === undefined ? {} : { excerpt }),
		...(url === undefined ? {} : { url }),
		...(system === undefined ? {} : { system }),
	}
}

const structuredAttribute = (signal: NormalizedSignal, key: string): unknown => {
	if (!isRecord(signal.data) || !isRecord(signal.data.record) || !isRecord(signal.data.record.attributes))
		return undefined
	return signal.data.record.attributes[key]
}

const issueLabels = (signal: NormalizedSignal): readonly string[] | undefined => {
	const value = structuredAttribute(signal, "gitlab.issue.labels")
	if (value === undefined) return undefined
	if (!Array.isArray(value)) throw new Error("GitLab projector gitlab.issue.labels must be an array")
	if (value.length > MAX_ISSUE_LABELS)
		throw new Error(`GitLab projector gitlab.issue.labels exceeds ${MAX_ISSUE_LABELS} labels`)
	return value.map((candidate, index) => {
		const label = `gitlab.issue.labels[${index}]`
		if (typeof candidate !== "string") throw new Error(`GitLab projector ${label} must be a string`)
		const normalized = candidate.trim()
		if (normalized.length === 0) throw new Error(`GitLab projector ${label} must not be blank`)
		if (Buffer.byteLength(normalized, "utf8") > MAX_ISSUE_LABEL_BYTES)
			throw new Error(`GitLab projector ${label} exceeds ${MAX_ISSUE_LABEL_BYTES} UTF-8 bytes`)
		return normalized
	})
}

const failedJobs = (signal: NormalizedSignal) => {
	const value = structuredAttribute(signal, "gitlab.ci.pipeline.failed_jobs")
	if (value === undefined) return undefined
	if (!Array.isArray(value))
		throw new Error("GitLab projector gitlab.ci.pipeline.failed_jobs must be an array")
	if (value.length > MAX_FAILED_JOBS)
		throw new Error(`GitLab projector gitlab.ci.pipeline.failed_jobs exceeds ${MAX_FAILED_JOBS} jobs`)
	return value.map((candidate, index) => {
		const label = `gitlab.ci.pipeline.failed_jobs[${index}]`
		if (!isRecord(candidate)) throw new Error(`GitLab projector ${label} must be an object`)
		const allowed = new Set(["id", "name", "stage", "status", "url"])
		if (Object.keys(candidate).some((key) => !allowed.has(key)))
			throw new Error(`GitLab projector ${label} contains an unknown field`)
		const scalar = (key: string): SignalScalar | undefined => {
			const item = candidate[key]
			if (item === undefined) return undefined
			if (typeof item !== "string") throw new Error(`GitLab projector ${label}.${key} must be a string`)
			if (key === "id") return { type: "int64", value: item }
			return { type: "string", value: item }
		}
		const id = positiveProjectorInt64(scalar("id"), `${label}.id`)
		const name = projectorString(scalar("name"), `${label}.name`, true)!
		const stage = projectorString(scalar("stage"), `${label}.stage`)
		const status = projectorToken(scalar("status"), `${label}.status`, true)!
		if (status !== "failed") throw new Error(`GitLab projector ${label}.status must be failed`)
		const url = projectorUrl(scalar("url"), `${label}.url`)
		return {
			id,
			name,
			...(stage === undefined ? {} : { stage }),
			status,
			...(url === undefined ? {} : { url }),
		}
	})
}

const project = (signal: NormalizedSignal) => {
	const id = positiveProjectorInt64(field(signal, "attribute", "gitlab.project.id"), "gitlab.project.id")
	const path = projectorString(
		field(signal, "attribute", "gitlab.project.path"),
		"gitlab.project.path",
		true,
	)!
	const oldPath = projectorString(
		field(signal, "attribute", "gitlab.project.old_path"),
		"gitlab.project.old_path",
	)
	return {
		id,
		path,
		...(oldPath === undefined ? {} : { oldPath }),
	}
}

const serviceName = (signal: NormalizedSignal): string | undefined =>
	projectorString(field(signal, "resource", "service.name"), "service.name")

const result = (signal: NormalizedSignal): string | undefined =>
	projectorString(field(signal, "attribute", "gitlab.event.result"), "gitlab.event.result")

const noProjectorConfig =
	(projectorId: string) =>
	(value: unknown): Record<string, never> => {
		if (!isRecord(value)) throw new Error(`${projectorId} projector config must be an object`)
		if (Object.keys(value).length > 0)
			throw new Error(`${projectorId} projector config contains unknown fields`)
		return {}
	}

export const gitlabProjectLifecycleProjector = {
	id: "gitlab.project.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.project.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-project-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.project.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const action = PROJECT_LIFECYCLE_ACTIONS[sourceEvent]
		if (action === undefined)
			throw new Error(`GitLab projector does not recognize project event ${sourceEvent}`)
		const projectData = project(signal)
		const eventActor = actor(signal)
		const eventServiceName = serviceName(signal)
		const eventResult = result(signal)
		return {
			subject: projectData.path,
			data: {
				project: projectData,
				action,
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabIssueLifecycleProjector = {
	id: "gitlab.issue.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.issue.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-issue-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.issue.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const action = ISSUE_LIFECYCLE_ACTIONS[sourceEvent as keyof typeof ISSUE_LIFECYCLE_ACTIONS]
		if (action === undefined)
			throw new Error(`GitLab projector does not recognize issue event ${sourceEvent}`)
		const projectData = project(signal)
		const issueData = issue(signal)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/issues/${issueData.iid}`,
			data: {
				project: projectData,
				issue: { ...issueData, action },
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabIssueCommentProjector = {
	id: "gitlab.issue.comment",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.issue.comment.v1",
	dataSchema: "urn:maple:event-schema:gitlab-issue-comment:v1",
	decodeConfig: noProjectorConfig("gitlab.issue.comment"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		if (sourceEvent !== "issue_comment")
			throw new Error(`GitLab projector does not recognize issue comment event ${sourceEvent}`)
		const projectData = project(signal)
		const issueData = issue(signal)
		const commentData = comment(signal)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/issues/${issueData.iid}#note_${commentData.id}`,
			data: {
				project: projectData,
				issue: issueData,
				comment: commentData,
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabMergeRequestLifecycleProjector = {
	id: "gitlab.merge-request.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.merge-request.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-merge-request-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.merge-request.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const action =
			MERGE_REQUEST_LIFECYCLE_ACTIONS[sourceEvent as keyof typeof MERGE_REQUEST_LIFECYCLE_ACTIONS]
		if (action === undefined)
			throw new Error(`GitLab projector does not recognize merge request event ${sourceEvent}`)
		const projectData = project(signal)
		const mergeRequestData = mergeRequest(signal)
		if (action === "review" && mergeRequestData.reviewState === undefined)
			throw new Error("GitLab projector is missing gitlab.merge_request.review_state")
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/merge_requests/${mergeRequestData.iid}`,
			data: {
				project: projectData,
				mergeRequest: { ...mergeRequestData, action },
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabMergeRequestCommentProjector = {
	id: "gitlab.merge-request.comment",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.merge-request.comment.v1",
	dataSchema: "urn:maple:event-schema:gitlab-merge-request-comment:v1",
	decodeConfig: noProjectorConfig("gitlab.merge-request.comment"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const kind =
			sourceEvent === "merge_request_comment"
				? "comment"
				: sourceEvent === "merge_request_review_comment"
					? "review"
					: undefined
		if (kind === undefined)
			throw new Error(`GitLab projector does not recognize merge request comment event ${sourceEvent}`)
		const projectData = project(signal)
		const mergeRequestData = mergeRequest(signal)
		const commentData = comment(signal, kind)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/merge_requests/${mergeRequestData.iid}#note_${commentData.id}`,
			data: {
				project: projectData,
				mergeRequest: mergeRequestData,
				comment: commentData,
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabPipelineCompletedProjector = {
	id: "gitlab.pipeline.completed",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.pipeline.completed.v1",
	dataSchema: "urn:maple:event-schema:gitlab-pipeline-completed:v1",
	decodeConfig: noProjectorConfig("gitlab.pipeline.completed"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		if (sourceEvent !== "ci_pipeline_completed")
			throw new Error(`GitLab projector does not recognize pipeline event ${sourceEvent}`)
		const projectData = project(signal)
		const id = positiveProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.id"),
			"gitlab.ci.pipeline.id",
		)
		const iid = optionalPositiveProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.iid"),
			"gitlab.ci.pipeline.iid",
		)
		const mergeRequestIid = optionalPositiveProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.merge_request_iid"),
			"gitlab.ci.pipeline.merge_request_iid",
		)
		const status = projectorString(
			field(signal, "attribute", "gitlab.ci.pipeline.status"),
			"gitlab.ci.pipeline.status",
			true,
		)!
		if (!TERMINAL_PIPELINE_STATUSES.has(status))
			throw new Error(`GitLab projector pipeline status ${status} is not terminal`)
		const name = projectorString(
			field(signal, "attribute", "gitlab.ci.pipeline.name"),
			"gitlab.ci.pipeline.name",
		)
		const pipelineSource = projectorString(
			field(signal, "attribute", "gitlab.ci.pipeline.source"),
			"gitlab.ci.pipeline.source",
		)
		const detailedStatus = projectorString(
			field(signal, "attribute", "gitlab.ci.pipeline.detailed_status"),
			"gitlab.ci.pipeline.detailed_status",
		)
		const url = projectorUrl(
			field(signal, "attribute", "gitlab.ci.pipeline.url"),
			"gitlab.ci.pipeline.url",
		)
		const ref = projectorString(field(signal, "attribute", "vcs.ref"), "vcs.ref")
		const sha = projectorString(
			field(signal, "attribute", "vcs.ref.head.revision"),
			"vcs.ref.head.revision",
		)
		const durationMs = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.duration_ms"),
			"gitlab.ci.pipeline.duration_ms",
		)
		const queuedDurationMs = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.queued_duration_ms"),
			"gitlab.ci.pipeline.queued_duration_ms",
		)
		const stageCount = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.stage_count"),
			"gitlab.ci.pipeline.stage_count",
		)
		const failedJobCount = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.failed_job_count"),
			"gitlab.ci.pipeline.failed_job_count",
		)
		const failedJobsTruncated = projectorBoolean(
			field(signal, "attribute", "gitlab.ci.pipeline.failed_jobs_truncated"),
			"gitlab.ci.pipeline.failed_jobs_truncated",
		)
		const pipelineFailedJobs = failedJobs(signal)
		if ((failedJobCount === undefined) !== (failedJobsTruncated === undefined))
			throw new Error("GitLab projector failed job count and truncation flag must be supplied together")
		if (pipelineFailedJobs !== undefined) {
			if (status !== "failed")
				throw new Error("GitLab projector failed jobs are only valid for a failed pipeline")
			if (failedJobCount === undefined)
				throw new Error("GitLab projector is missing gitlab.ci.pipeline.failed_job_count")
			if (failedJobsTruncated === undefined)
				throw new Error("GitLab projector is missing gitlab.ci.pipeline.failed_jobs_truncated")
			if (BigInt(failedJobCount) < BigInt(pipelineFailedJobs.length))
				throw new Error("GitLab projector failed job count is smaller than the summary list")
			if (failedJobsTruncated !== BigInt(failedJobCount) > BigInt(pipelineFailedJobs.length))
				throw new Error("GitLab projector failed job truncation flag is inconsistent")
		}
		const eventActor = actor(signal)
		const eventServiceName = serviceName(signal)
		const eventResult = result(signal)
		return {
			subject: `${projectData.path}/-/pipelines/${id}`,
			data: {
				project: projectData,
				pipeline: {
					id,
					...(iid === undefined ? {} : { iid }),
					...(mergeRequestIid === undefined ? {} : { mergeRequestIid }),
					status,
					...(name === undefined ? {} : { name }),
					...(pipelineSource === undefined ? {} : { source: pipelineSource }),
					...(detailedStatus === undefined ? {} : { detailedStatus }),
					...(url === undefined ? {} : { url }),
					...(ref === undefined ? {} : { ref }),
					...(sha === undefined ? {} : { sha }),
					...(durationMs === undefined ? {} : { durationMs }),
					...(queuedDurationMs === undefined ? {} : { queuedDurationMs }),
					...(stageCount === undefined ? {} : { stageCount }),
					...(failedJobCount === undefined ? {} : { failedJobCount }),
					...(failedJobsTruncated === undefined ? {} : { failedJobsTruncated }),
					...(pipelineFailedJobs === undefined ? {} : { failedJobs: pipelineFailedJobs }),
				},
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabDeploymentLifecycleProjector = {
	id: "gitlab.deployment.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.deployment.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-deployment-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.deployment.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const expectedStatus = DEPLOYMENT_STATUSES[sourceEvent as keyof typeof DEPLOYMENT_STATUSES]
		if (expectedStatus === undefined)
			throw new Error(`GitLab projector does not recognize deployment event ${sourceEvent}`)
		const projectData = project(signal)
		const id = positiveProjectorInt64(
			field(signal, "attribute", "gitlab.deployment.id"),
			"gitlab.deployment.id",
		)
		const environment = projectorString(
			field(signal, "attribute", "gitlab.deployment.environment"),
			"gitlab.deployment.environment",
			true,
		)!
		const status = projectorToken(
			field(signal, "attribute", "gitlab.deployment.status"),
			"gitlab.deployment.status",
			true,
		)!
		if (status !== expectedStatus)
			throw new Error(`GitLab projector deployment status ${status} conflicts with ${sourceEvent}`)
		const revision = projectorRevision(
			field(signal, "attribute", "gitlab.deployment.revision"),
			"gitlab.deployment.revision",
		)
		const url = projectorUrl(field(signal, "attribute", "gitlab.deployment.url"), "gitlab.deployment.url")
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/deployments/${id}`,
			data: {
				project: projectData,
				deployment: {
					id,
					environment,
					status,
					...(revision === undefined ? {} : { revision }),
					...(url === undefined ? {} : { url }),
				},
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabJobLifecycleProjector = {
	id: "gitlab.job.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.job.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-job-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.job.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const match = /^ci_job_([a-z][a-z0-9_]{0,63})$/.exec(sourceEvent)
		const action = match?.[1]
		if (action === undefined || !JOB_STATUSES.has(action))
			throw new Error(`GitLab projector does not recognize job event ${sourceEvent}`)
		const projectData = project(signal)
		const id = positiveProjectorInt64(field(signal, "attribute", "gitlab.ci.job.id"), "gitlab.ci.job.id")
		const name = projectorString(
			field(signal, "attribute", "gitlab.ci.job.name"),
			"gitlab.ci.job.name",
			true,
		)!
		const stage = projectorString(
			field(signal, "attribute", "gitlab.ci.job.stage"),
			"gitlab.ci.job.stage",
		)
		const status = projectorToken(
			field(signal, "attribute", "gitlab.ci.job.status"),
			"gitlab.ci.job.status",
			true,
		)!
		if (status !== action)
			throw new Error(`GitLab projector job status ${status} conflicts with ${sourceEvent}`)
		const url = projectorUrl(field(signal, "attribute", "gitlab.ci.job.url"), "gitlab.ci.job.url")
		const pipelineId = optionalPositiveProjectorInt64(
			field(signal, "attribute", "gitlab.ci.pipeline.id"),
			"gitlab.ci.pipeline.id",
		)
		const ref = projectorString(field(signal, "attribute", "vcs.ref"), "vcs.ref")
		const revision = projectorRevision(
			field(signal, "attribute", "vcs.ref.head.revision"),
			"vcs.ref.head.revision",
		)
		const durationMs = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.ci.job.duration_ms"),
			"gitlab.ci.job.duration_ms",
		)
		const allowFailure = projectorBoolean(
			field(signal, "attribute", "gitlab.ci.job.allow_failure"),
			"gitlab.ci.job.allow_failure",
		)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/jobs/${id}`,
			data: {
				project: projectData,
				job: {
					id,
					name,
					status,
					...(stage === undefined ? {} : { stage }),
					...(url === undefined ? {} : { url }),
					...(pipelineId === undefined ? {} : { pipelineId }),
					...(ref === undefined ? {} : { ref }),
					...(revision === undefined ? {} : { revision }),
					...(durationMs === undefined ? {} : { durationMs }),
					...(allowFailure === undefined ? {} : { allowFailure }),
				},
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

const REF_EVENTS = {
	branch_create: { type: "branch", action: "create" },
	branch_update: { type: "branch", action: "update" },
	branch_delete: { type: "branch", action: "delete" },
	tag_create: { type: "tag", action: "create" },
	tag_update: { type: "tag", action: "update" },
	tag_delete: { type: "tag", action: "delete" },
} as const

export const gitlabRefLifecycleProjector = {
	id: "gitlab.ref.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.ref.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-ref-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.ref.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const lifecycle = REF_EVENTS[sourceEvent as keyof typeof REF_EVENTS]
		if (lifecycle === undefined)
			throw new Error(`GitLab projector does not recognize ref event ${sourceEvent}`)
		const projectData = project(signal)
		const name = projectorString(field(signal, "attribute", "vcs.ref"), "vcs.ref", true)!
		const before = projectorRevision(
			field(signal, "attribute", "vcs.ref.base.revision"),
			"vcs.ref.base.revision",
			true,
		)!
		const after = projectorRevision(
			field(signal, "attribute", "vcs.ref.head.revision"),
			"vcs.ref.head.revision",
			true,
		)!
		const url = projectorUrl(field(signal, "attribute", "gitlab.ref.url"), "gitlab.ref.url")
		const commitCount = nonNegativeProjectorInt64(
			field(signal, "attribute", "gitlab.push.commit_count"),
			"gitlab.push.commit_count",
		)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/refs/${name}`,
			data: {
				project: projectData,
				ref: {
					...lifecycle,
					name,
					before,
					after,
					...(url === undefined ? {} : { url }),
					...(commitCount === undefined ? {} : { commitCount }),
				},
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const gitlabReleaseLifecycleProjector = {
	id: "gitlab.release.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.release.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-release-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.release.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const match = /^release_([a-z][a-z0-9_]{0,63})$/.exec(sourceEvent)
		const action = match?.[1]
		if (action === undefined || !RELEASE_ACTIONS.has(action))
			throw new Error(`GitLab projector does not recognize release event ${sourceEvent}`)
		const projectData = project(signal)
		const id = optionalPositiveProjectorInt64(
			field(signal, "attribute", "gitlab.release.id"),
			"gitlab.release.id",
		)
		const tag = projectorString(
			field(signal, "attribute", "gitlab.release.tag"),
			"gitlab.release.tag",
			true,
		)!
		const name = projectorString(field(signal, "attribute", "gitlab.release.name"), "gitlab.release.name")
		const url = projectorUrl(field(signal, "attribute", "gitlab.release.url"), "gitlab.release.url")
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/releases/${tag}`,
			data: {
				project: projectData,
				release: {
					...(id === undefined ? {} : { id }),
					tag,
					action,
					...(name === undefined ? {} : { name }),
					...(url === undefined ? {} : { url }),
				},
				sourceEvent,
				...(eventActor === undefined ? {} : { actor: eventActor }),
				...(eventResult === undefined ? {} : { result: eventResult }),
				...(eventServiceName === undefined ? {} : { serviceName: eventServiceName }),
			},
		}
	},
} as const

export const registerGitLabProjectors = (registry: ProjectorRegistry): ProjectorRegistry =>
	registry
		.register(gitlabIssueCreatedProjector)
		.register(gitlabProjectLifecycleProjector)
		.register(gitlabIssueLifecycleProjector)
		.register(gitlabIssueCommentProjector)
		.register(gitlabMergeRequestLifecycleProjector)
		.register(gitlabMergeRequestCommentProjector)
		.register(gitlabPipelineCompletedProjector)
		.register(gitlabDeploymentLifecycleProjector)
		.register(gitlabJobLifecycleProjector)
		.register(gitlabRefLifecycleProjector)
		.register(gitlabReleaseLifecycleProjector)

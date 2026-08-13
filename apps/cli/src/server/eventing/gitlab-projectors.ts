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
const MAX_PROJECTOR_TEXT_BYTES = 4 * 1024

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
	if (name === undefined && id === undefined) return undefined
	return {
		...(id === undefined ? {} : { id }),
		...(name === undefined ? {} : { name }),
	}
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

export const gitlabMergeRequestLifecycleProjector = {
	id: "gitlab.merge-request.lifecycle",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.merge-request.lifecycle.v1",
	dataSchema: "urn:maple:event-schema:gitlab-merge-request-lifecycle:v1",
	decodeConfig: noProjectorConfig("gitlab.merge-request.lifecycle"),
	project: (signal: NormalizedSignal) => {
		const sourceEvent = eventName(signal)
		const match = /^merge_request_([a-z][a-z0-9_]{0,63})$/.exec(sourceEvent)
		if (!match) throw new Error(`GitLab projector does not recognize merge request event ${sourceEvent}`)
		const projectData = project(signal)
		const iid = positiveProjectorInt64(
			field(signal, "attribute", "gitlab.merge_request.iid"),
			"gitlab.merge_request.iid",
		)
		const sourceBranch = projectorString(
			field(signal, "attribute", "gitlab.merge_request.source_branch"),
			"gitlab.merge_request.source_branch",
		)
		const targetBranch = projectorString(
			field(signal, "attribute", "gitlab.merge_request.target_branch"),
			"gitlab.merge_request.target_branch",
		)
		const commit = projectorString(
			field(signal, "attribute", "gitlab.merge_request.commit"),
			"gitlab.merge_request.commit",
		)
		const eventActor = actor(signal)
		const eventResult = result(signal)
		const eventServiceName = serviceName(signal)
		return {
			subject: `${projectData.path}/-/merge_requests/${iid}`,
			data: {
				project: projectData,
				mergeRequest: {
					iid,
					action: match[1]!,
					...(sourceBranch === undefined ? {} : { sourceBranch }),
					...(targetBranch === undefined ? {} : { targetBranch }),
					...(commit === undefined ? {} : { commit }),
				},
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
					status,
					...(name === undefined ? {} : { name }),
					...(pipelineSource === undefined ? {} : { source: pipelineSource }),
					...(detailedStatus === undefined ? {} : { detailedStatus }),
					...(ref === undefined ? {} : { ref }),
					...(sha === undefined ? {} : { sha }),
					...(durationMs === undefined ? {} : { durationMs }),
					...(queuedDurationMs === undefined ? {} : { queuedDurationMs }),
					...(stageCount === undefined ? {} : { stageCount }),
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
		.register(gitlabMergeRequestLifecycleProjector)
		.register(gitlabPipelineCompletedProjector)

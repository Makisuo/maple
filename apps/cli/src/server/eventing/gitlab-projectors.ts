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

const field = (signal: NormalizedSignal, namespace: "resource" | "attribute", key: string) =>
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

const gitlabIssueProjector = {
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

export const registerGitLabProjectors = (registry: ProjectorRegistry): ProjectorRegistry =>
	registry.register(gitlabIssueProjector)

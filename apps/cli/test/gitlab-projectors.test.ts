import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { describe, it } from "vitest"
import {
	CompiledProjectionRegistry,
	ProjectorRegistry,
	SignalSourceRegistry,
	makeEventId,
	validateMapleCloudEvent,
	type SignalPredicate,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import samples from "./fixtures/gitlab-projectors.v1.json"
import identities from "./fixtures/gitlab-projector-identities.v1.json"
import {
	gitlabDeploymentLifecycleProjector,
	gitlabIssueCommentProjector,
	gitlabJobLifecycleProjector,
	gitlabMergeRequestLifecycleProjector,
	gitlabPipelineCompletedProjector,
	gitlabProjectLifecycleProjector,
	registerGitLabProjectors,
} from "../src/server/eventing/gitlab-projectors"
import { OTLP_LOG_ADAPTER, normalizeOtlpLogs } from "../src/server/eventing/otlp"

const stringAttr = (key: string, value: string) => ({ key, value: { stringValue: value } })
const intAttr = (key: string, value: string) => ({ key, value: { intValue: value } })
const boolAttr = (key: string, value: boolean) => ({ key, value: { boolValue: value } })
const stringArrayAttr = (key: string, values: readonly string[]) => ({
	key,
	value: { arrayValue: { values: values.map((value) => ({ stringValue: value })) } },
})
const failedJobsAttr = (
	jobs: ReadonlyArray<{
		readonly id: string
		readonly name: string
		readonly stage?: string
		readonly url?: string
	}>,
) => ({
	key: "gitlab.ci.pipeline.failed_jobs",
	value: {
		arrayValue: {
			values: jobs.map((job) => ({
				kvlistValue: {
					values: [
						{ key: "id", value: { intValue: job.id } },
						{ key: "name", value: { stringValue: job.name } },
						...(job.stage === undefined
							? []
							: [{ key: "stage", value: { stringValue: job.stage } }]),
						{ key: "status", value: { stringValue: "failed" } },
						...(job.url === undefined ? [] : [{ key: "url", value: { stringValue: job.url } }]),
					],
				},
			})),
		},
	},
})

const gitlabEvent = (eventName: string, eventId: string, extra: readonly unknown[] = []) => ({
	resourceLogs: [
		{
			resource: {
				attributes: [
					stringAttr("service.name", "gitlab-repository-events"),
					stringAttr("service.version", "19.1.0"),
				],
			},
			scopeLogs: [
				{
					scope: { name: "srvmini2.gitlab.repository-events", version: "1" },
					logRecords: [
						{
							timeUnixNano: "1786131720123456789",
							observedTimeUnixNano: "1786131721123456789",
							severityNumber: 9,
							severityText: "INFO",
							body: { stringValue: `gitlab event ${eventName}` },
							attributes: [
								stringAttr("event.id", eventId),
								stringAttr("event.source", "https://gitlab.internal"),
								stringAttr("event.name", eventName),
								stringAttr("gitlab.event.id", eventId),
								stringAttr("gitlab.event.result", "success"),
								intAttr("gitlab.project.id", "42"),
								stringAttr("gitlab.project.path", "rdev/maple"),
								intAttr("gitlab.actor.id", "9"),
								stringAttr("gitlab.actor.name", "rdev"),
								...extra,
							],
						},
					],
				},
			],
		},
	],
})

const normalizedEvent = (request: unknown) => {
	const [signal] = normalizeOtlpLogs(request, "2026-08-07T20:00:00Z")
	if (!signal) throw new Error("test event did not normalize")
	return signal
}

const withoutAttribute = (request: ReturnType<typeof gitlabEvent>, key: string) => {
	const copy = structuredClone(request)
	copy.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes =
		copy.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.filter((entry) => entry.key !== key)
	return copy
}

const selectorFor = (eventName: string): SignalPredicate => ({
	op: "eq",
	field: { namespace: "attribute", key: "event.name", type: "string" },
	value: { type: "string", value: eventName },
})

const evaluate = (
	projectorId: string,
	projectionId: string,
	eventName: string,
	signal: ReturnType<typeof normalizedEvent>,
) => {
	const spec: SignalProjectionSpec = {
		id: projectionId,
		revision: 1,
		enabled: true,
		tenantId: "local",
		sourceKind: "otel.log",
		selector: selectorFor(eventName),
		projector: { id: projectorId, version: 1, config: {} },
		activeFrom: "2000-01-01T00:00:00Z",
	}
	const sources = new SignalSourceRegistry().register(OTLP_LOG_ADAPTER.definition)
	const projectors = registerGitLabProjectors(new ProjectorRegistry())
	return CompiledProjectionRegistry.compile([spec], sources, projectors).evaluate(signal)
}

describe("GitLab event projectors", () => {
	it("projects the production receiver's project lifecycle fields", () => {
		const signal = normalizedEvent(
			gitlabEvent("project_rename", "project-event-42", [
				stringAttr("gitlab.project.old_path", "rdev/old-maple"),
			]),
		)
		const result = evaluate(
			"gitlab.project.lifecycle",
			"gitlab-project-renamed",
			"project_rename",
			signal,
		)
		strictEqual(result.failures.length, 0)
		strictEqual(result.events[0]?.id, samples[0]?.id)
		deepStrictEqual(result.events[0]?.data, {
			project: { id: "42", path: "rdev/maple", oldPath: "rdev/old-maple" },
			action: "renamed",
			sourceEvent: "project_rename",
			actor: { id: "9", name: "rdev" },
			result: "success",
			serviceName: "gitlab-repository-events",
		})
		strictEqual(result.events[0]?.subject, "rdev/maple")
	})

	it("maps every normalized project lifecycle event to a version-1 action", () => {
		const actions = {
			project_create: "created",
			project_destroy: "destroyed",
			project_rename: "renamed",
			project_transfer: "transferred",
			project_update: "updated",
			project_archive: "archived",
			project_unarchive: "unarchived",
			project_deletion_request: "deletion_requested",
		} as const
		for (const [sourceEvent, action] of Object.entries(actions)) {
			const result = evaluate(
				"gitlab.project.lifecycle",
				`gitlab-project-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(gitlabEvent(sourceEvent, `project-${sourceEvent}`)),
			)
			strictEqual(result.failures.length, 0)
			const event = result.events[0]
			if (!event) throw new Error(`projector did not emit ${sourceEvent}`)
			strictEqual((event.data as { readonly action?: string }).action, action)
		}
	})

	it("projects merge-request lifecycle data without inventing absent fields", () => {
		const signal = normalizedEvent(
			gitlabEvent("merge_request_open", "mr-event-7", [
				intAttr("gitlab.merge_request.iid", "7"),
				stringAttr("gitlab.merge_request.source_branch", "feature/maple"),
				stringAttr("gitlab.merge_request.target_branch", "main"),
				stringAttr("gitlab.merge_request.commit", "abc123"),
			]),
		)
		const result = evaluate(
			"gitlab.merge-request.lifecycle",
			"gitlab-mr-opened",
			"merge_request_open",
			signal,
		)
		strictEqual(result.failures.length, 0)
		strictEqual(result.events[0]?.id, samples[1]?.id)
		deepStrictEqual(result.events[0]?.data, {
			project: { id: "42", path: "rdev/maple" },
			mergeRequest: {
				iid: "7",
				action: "open",
				sourceBranch: "feature/maple",
				targetBranch: "main",
				commit: "abc123",
			},
			sourceEvent: "merge_request_open",
			actor: { id: "9", name: "rdev" },
			result: "success",
			serviceName: "gitlab-repository-events",
		})
		strictEqual(result.events[0]?.subject, "rdev/maple/-/merge_requests/7")
	})

	it("projects only terminal pipeline events from the normalized receiver fields", () => {
		const signal = normalizedEvent(
			gitlabEvent("ci_pipeline_completed", "pipeline-event-900", [
				stringAttr("gitlab.event.result", "failure"),
				intAttr("gitlab.ci.pipeline.id", "900"),
				intAttr("gitlab.ci.pipeline.iid", "12"),
				stringAttr("gitlab.ci.pipeline.status", "failed"),
				stringAttr("gitlab.ci.pipeline.detailed_status", "failed"),
				stringAttr("gitlab.ci.pipeline.name", "Maple CI"),
				stringAttr("gitlab.ci.pipeline.source", "push"),
				stringAttr("vcs.ref", "main"),
				stringAttr("vcs.ref.head.revision", "deadbeef"),
				intAttr("gitlab.ci.pipeline.duration_ms", "63000"),
				intAttr("gitlab.ci.pipeline.queued_duration_ms", "10000"),
				intAttr("gitlab.ci.pipeline.stage_count", "3"),
			]),
		)
		const result = evaluate(
			"gitlab.pipeline.completed",
			"gitlab-pipeline-completed",
			"ci_pipeline_completed",
			signal,
		)
		strictEqual(result.failures.length, 0)
		strictEqual(result.events[0]?.id, samples[2]?.id)
		deepStrictEqual(result.events[0]?.data, {
			project: { id: "42", path: "rdev/maple" },
			pipeline: {
				id: "900",
				iid: "12",
				status: "failed",
				name: "Maple CI",
				source: "push",
				detailedStatus: "failed",
				ref: "main",
				sha: "deadbeef",
				durationMs: "63000",
				queuedDurationMs: "10000",
				stageCount: "3",
			},
			sourceEvent: "ci_pipeline_completed",
			actor: { id: "9", name: "rdev" },
			result: "failure",
			serviceName: "gitlab-repository-events",
		})
		strictEqual(result.events[0]?.subject, "rdev/maple/-/pipelines/900")
	})

	it("projects every issue lifecycle action and sanitized issue comments", () => {
		for (const [sourceEvent, action] of Object.entries({
			issue_open: "open",
			issue_update: "update",
			issue_close: "close",
			issue_reopen: "reopen",
		})) {
			const result = evaluate(
				"gitlab.issue.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-issue:${sourceEvent}`, [
						intAttr("gitlab.issue.id", "70"),
						intAttr("gitlab.issue.iid", "7"),
						stringAttr("gitlab.issue.title", "Typed events"),
						stringAttr("gitlab.issue.url", "https://gitlab.internal/rdev/maple/-/issues/7"),
						stringArrayAttr("gitlab.issue.labels", ["agent-ready", "backend"]),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
			strictEqual((result.events[0]?.data as { issue: { action: string } }).issue.action, action)
		}

		const commentResult = evaluate(
			"gitlab.issue.comment",
			"gitlab-issue-comment",
			"issue_comment",
			normalizedEvent(
				gitlabEvent("issue_comment", "delivery-comment:0", [
					intAttr("gitlab.issue.iid", "7"),
					intAttr("gitlab.comment.id", "81"),
					stringArrayAttr("gitlab.issue.labels", ["agent-ready", "backend"]),
					stringAttr("gitlab.comment.excerpt", "  hello\u0000\n\tMaple  "),
					stringAttr("gitlab.comment.url", "https://gitlab.internal/rdev/maple/-/issues/7#note_81"),
				]),
			),
		)
		strictEqual(commentResult.failures.length, 0)
		deepStrictEqual(commentResult.events[0]?.data, {
			project: { id: "42", path: "rdev/maple" },
			issue: { iid: "7", labels: ["agent-ready", "backend"] },
			comment: {
				id: "81",
				excerpt: "hello Maple",
				url: "https://gitlab.internal/rdev/maple/-/issues/7#note_81",
			},
			sourceEvent: "issue_comment",
			actor: { id: "9", name: "rdev" },
			result: "success",
			serviceName: "gitlab-repository-events",
		})
	})

	it("uses an explicit MR lifecycle vocabulary and distinguishes review comments", () => {
		for (const [sourceEvent, action] of Object.entries({
			merge_request_open: "open",
			merge_request_update: "update",
			merge_request_close: "close",
			merge_request_reopen: "reopen",
			merge_request_merge: "merge",
			merge_request_review: "review",
		})) {
			const extras = [
				intAttr("gitlab.merge_request.iid", "7"),
				stringAttr("gitlab.merge_request.title", "Freeze contracts"),
				stringAttr(
					"gitlab.merge_request.url",
					"https://gitlab.internal/rdev/maple/-/merge_requests/7",
				),
				...(sourceEvent === "merge_request_review"
					? [stringAttr("gitlab.merge_request.review_state", "approved")]
					: []),
			]
			const result = evaluate(
				"gitlab.merge-request.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(gitlabEvent(sourceEvent, `delivery-mr:${sourceEvent}`, extras)),
			)
			strictEqual(result.failures.length, 0)
			strictEqual(
				(result.events[0]?.data as { mergeRequest: { action: string } }).mergeRequest.action,
				action,
			)
		}

		for (const [sourceEvent, kind] of [
			["merge_request_comment", "comment"],
			["merge_request_review_comment", "review"],
		] as const) {
			const result = evaluate(
				"gitlab.merge-request.comment",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-mr-comment:${sourceEvent}`, [
						intAttr("gitlab.merge_request.iid", "7"),
						intAttr("gitlab.comment.id", "82"),
						stringAttr("gitlab.comment.excerpt", "Please add a fixture"),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
			strictEqual((result.events[0]?.data as { comment: { kind: string } }).comment.kind, kind)
		}
	})

	it("projects bounded failed-job summaries with canonical pipeline metadata", () => {
		const result = evaluate(
			"gitlab.pipeline.completed",
			"gitlab-pipeline-enriched",
			"ci_pipeline_completed",
			normalizedEvent(
				gitlabEvent("ci_pipeline_completed", "delivery-pipeline:0", [
					intAttr("gitlab.ci.pipeline.id", "900"),
					stringAttr("gitlab.ci.pipeline.status", "failed"),
					intAttr("gitlab.ci.pipeline.merge_request_iid", "7"),
					stringAttr(
						"gitlab.ci.pipeline.url",
						"https://gitlab.internal/rdev/maple/-/pipelines/900",
					),
					intAttr("gitlab.ci.pipeline.failed_job_count", "3"),
					boolAttr("gitlab.ci.pipeline.failed_jobs_truncated", true),
					failedJobsAttr([
						{
							id: "901",
							name: "unit",
							stage: "test",
							url: "https://gitlab.internal/rdev/maple/-/jobs/901",
						},
						{ id: "902", name: "integration", stage: "test" },
					]),
				]),
			),
		)
		strictEqual(result.failures.length, 0)
		deepStrictEqual(
			(result.events[0]?.data as { pipeline: { failedJobCount: string; failedJobsTruncated: boolean } })
				.pipeline,
			{
				id: "900",
				mergeRequestIid: "7",
				status: "failed",
				url: "https://gitlab.internal/rdev/maple/-/pipelines/900",
				failedJobCount: "3",
				failedJobsTruncated: true,
				failedJobs: [
					{
						id: "901",
						name: "unit",
						stage: "test",
						status: "failed",
						url: "https://gitlab.internal/rdev/maple/-/jobs/901",
					},
					{ id: "902", name: "integration", stage: "test", status: "failed" },
				],
			},
		)
	})

	it("projects deployment and job lifecycle contracts with status agreement", () => {
		for (const [sourceEvent, status] of Object.entries({
			deployment_running: "running",
			deployment_success: "success",
			deployment_failed: "failed",
			deployment_canceled: "canceled",
			deployment_blocked: "blocked",
			deployment_manual: "manual",
		})) {
			const result = evaluate(
				"gitlab.deployment.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-deployment:${sourceEvent}`, [
						intAttr("gitlab.deployment.id", "501"),
						stringAttr("gitlab.deployment.environment", "production"),
						stringAttr("gitlab.deployment.status", status),
						stringAttr("gitlab.deployment.revision", "a8123fa"),
						stringAttr(
							"gitlab.deployment.url",
							"https://gitlab.internal/rdev/maple/-/deployments/501",
						),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
			strictEqual(
				(result.events[0]?.data as { deployment: { status: string } }).deployment.status,
				status,
			)
		}

		for (const status of [
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
		]) {
			const sourceEvent = `ci_job_${status}`
			const result = evaluate(
				"gitlab.job.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-job:${status}`, [
						intAttr("gitlab.ci.job.id", "901"),
						stringAttr("gitlab.ci.job.name", "unit"),
						stringAttr("gitlab.ci.job.status", status),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
		}
	})

	it("projects normalized branch/tag transitions and release lifecycle without descriptions", () => {
		for (const [sourceEvent, type, action] of [
			["branch_create", "branch", "create"],
			["branch_update", "branch", "update"],
			["branch_delete", "branch", "delete"],
			["tag_create", "tag", "create"],
			["tag_update", "tag", "update"],
			["tag_delete", "tag", "delete"],
		] as const) {
			const result = evaluate(
				"gitlab.ref.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-ref:${sourceEvent}`, [
						stringAttr("vcs.ref", type === "branch" ? "refs/heads/main" : "refs/tags/v1.0.0"),
						stringAttr("vcs.ref.base.revision", "0000000000000000000000000000000000000000"),
						stringAttr("vcs.ref.head.revision", "a8123faa8123faa8123faa8123faa8123faa8123"),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
			deepStrictEqual((result.events[0]?.data as { ref: { type: string; action: string } }).ref, {
				type,
				action,
				name: type === "branch" ? "refs/heads/main" : "refs/tags/v1.0.0",
				before: "0000000000000000000000000000000000000000",
				after: "a8123faa8123faa8123faa8123faa8123faa8123",
			})
		}

		for (const action of ["create", "update", "delete"]) {
			const sourceEvent = `release_${action}`
			const result = evaluate(
				"gitlab.release.lifecycle",
				`gitlab-${sourceEvent}`,
				sourceEvent,
				normalizedEvent(
					gitlabEvent(sourceEvent, `delivery-release:${action}`, [
						stringAttr("gitlab.release.tag", "v1.0.0"),
						stringAttr("gitlab.release.name", "Maple 1.0"),
					]),
				),
			)
			strictEqual(result.failures.length, 0)
			strictEqual((result.events[0]?.data as { release: { action: string } }).release.action, action)
			strictEqual("description" in (result.events[0]?.data as { release: object }).release, false)
		}
	})

	it("keeps source identity and the CloudEvent ID deterministic across retries", () => {
		const first = normalizedEvent(gitlabEvent("project_create", "project-event-42"))
		const retry = normalizedEvent(gitlabEvent("project_create", "project-event-42"))
		const firstResult = evaluate(
			"gitlab.project.lifecycle",
			"gitlab-project-created",
			"project_create",
			first,
		)
		const retryResult = evaluate(
			"gitlab.project.lifecycle",
			"gitlab-project-created",
			"project_create",
			retry,
		)
		strictEqual(first.occurrenceId, "project-event-42")
		strictEqual(retry.occurrenceId, "project-event-42")
		strictEqual(firstResult.events[0]?.id, retryResult.events[0]?.id)
		strictEqual(
			firstResult.events[0]?.id,
			"sha256:8f45527a4e615e057142026df477f20e2e6d63ae55bc761ce4dc151dda706811",
		)
		strictEqual(firstResult.events[0]?.id?.startsWith("sha256:"), true)
	})

	it("fails closed on missing or malformed required fields", () => {
		const missingProjectId = normalizedEvent(
			withoutAttribute(gitlabEvent("project_create", "project-event-missing"), "gitlab.project.id"),
		)
		const badProjectId = normalizedEvent(
			gitlabEvent("project_create", "project-event-bad", [
				stringAttr("gitlab.project.id", "not-an-int"),
			]),
		)
		const missingIdResult = evaluate(
			"gitlab.project.lifecycle",
			"gitlab-project-missing",
			"project_create",
			missingProjectId,
		)
		const badIdResult = evaluate(
			"gitlab.project.lifecycle",
			"gitlab-project-bad",
			"project_create",
			badProjectId,
		)
		strictEqual(missingIdResult.failures.length, 1)
		strictEqual(missingIdResult.failures[0]?.message, "GitLab projector is missing gitlab.project.id")
		strictEqual(badIdResult.failures.length, 1)
		strictEqual(badIdResult.failures[0]?.message, "GitLab projector gitlab.project.id must be an int64")
	})

	it("rejects nonterminal pipeline status, unknown actions, and unknown config fields", () => {
		const running = normalizedEvent(
			gitlabEvent("ci_pipeline_completed", "pipeline-running", [
				intAttr("gitlab.ci.pipeline.id", "900"),
				stringAttr("gitlab.ci.pipeline.status", "running"),
			]),
		)
		throws(
			() => gitlabPipelineCompletedProjector.project(running),
			/GitLab projector pipeline status running is not terminal/,
		)
		const unknownAction = normalizedEvent(
			gitlabEvent("merge_request_??", "mr-invalid", [intAttr("gitlab.merge_request.iid", "7")]),
		)
		throws(
			() => gitlabMergeRequestLifecycleProjector.project(unknownAction),
			/GitLab projector does not recognize merge request event/,
		)
		const unknownBoundedAction = normalizedEvent(
			gitlabEvent("merge_request_deploy", "mr-invalid-bounded", [
				intAttr("gitlab.merge_request.iid", "7"),
			]),
		)
		throws(
			() => gitlabMergeRequestLifecycleProjector.project(unknownBoundedAction),
			/GitLab projector does not recognize merge request event/,
		)
		throws(
			() => gitlabProjectLifecycleProjector.decodeConfig({ includeBody: true }),
			/gitlab\.project\.lifecycle projector config contains unknown fields/,
		)
	})

	it("fails closed on inconsistent statuses, unsafe URLs, and collection bounds", () => {
		const deploymentMismatch = normalizedEvent(
			gitlabEvent("deployment_success", "deployment-mismatch", [
				intAttr("gitlab.deployment.id", "501"),
				stringAttr("gitlab.deployment.environment", "production"),
				stringAttr("gitlab.deployment.status", "failed"),
			]),
		)
		throws(
			() => gitlabDeploymentLifecycleProjector.project(deploymentMismatch),
			/status failed conflicts with deployment_success/,
		)

		const jobMismatch = normalizedEvent(
			gitlabEvent("ci_job_success", "job-mismatch", [
				intAttr("gitlab.ci.job.id", "901"),
				stringAttr("gitlab.ci.job.name", "unit"),
				stringAttr("gitlab.ci.job.status", "failed"),
			]),
		)
		throws(() => gitlabJobLifecycleProjector.project(jobMismatch), /status failed conflicts/)

		const unsafeUrl = normalizedEvent(
			gitlabEvent("issue_comment", "comment-query", [
				intAttr("gitlab.issue.iid", "7"),
				intAttr("gitlab.comment.id", "81"),
				stringAttr("gitlab.comment.url", "https://gitlab.internal/note?private=value"),
			]),
		)
		throws(() => gitlabIssueCommentProjector.project(unsafeUrl), /must not contain a query or fragment/)

		const tooManyJobs = normalizedEvent(
			gitlabEvent("ci_pipeline_completed", "pipeline-too-many-jobs", [
				intAttr("gitlab.ci.pipeline.id", "900"),
				stringAttr("gitlab.ci.pipeline.status", "failed"),
				failedJobsAttr(
					Array.from({ length: 21 }, (_, index) => ({
						id: String(index + 1),
						name: `job-${index}`,
					})),
				),
			]),
		)
		throws(() => gitlabPipelineCompletedProjector.project(tooManyJobs), /exceeds 20 jobs/)

		const oversizedExcerpt = normalizedEvent(
			gitlabEvent("issue_comment", "comment-too-long", [
				intAttr("gitlab.issue.iid", "7"),
				intAttr("gitlab.comment.id", "81"),
				stringAttr("gitlab.comment.excerpt", "x".repeat(1025)),
			]),
		)
		throws(() => gitlabIssueCommentProjector.project(oversizedExcerpt), /exceeds 1024 UTF-8 bytes/)

		const tooManyLabels = normalizedEvent(
			gitlabEvent("issue_open", "issue-too-many-labels", [
				intAttr("gitlab.issue.iid", "7"),
				stringArrayAttr(
					"gitlab.issue.labels",
					Array.from({ length: 51 }, (_, index) => `label-${index}`),
				),
			]),
		)
		const labelsResult = evaluate(
			"gitlab.issue.lifecycle",
			"gitlab-issue-labels-bounded",
			"issue_open",
			tooManyLabels,
		)
		strictEqual(
			labelsResult.failures[0]?.message,
			"GitLab projector gitlab.issue.labels exceeds 50 labels",
		)
	})

	it("preserves indexed producer occurrence IDs as distinct deterministic CloudEvent identities", () => {
		const request = gitlabEvent("project_update", "delivery-uuid:0")
		const second = structuredClone(request.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!)
		second.attributes = second.attributes.map((entry) =>
			entry.key === "event.id" || entry.key === "gitlab.event.id"
				? stringAttr(entry.key, "delivery-uuid:1")
				: entry,
		)
		request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(second)
		const signals = normalizeOtlpLogs(request, "2026-08-07T20:00:00Z")
		deepStrictEqual(
			signals.map(({ occurrenceId }) => occurrenceId),
			["delivery-uuid:0", "delivery-uuid:1"],
		)
		const ids = signals.map(
			(signal) =>
				evaluate("gitlab.project.lifecycle", "gitlab-project-updated", "project_update", signal)
					.events[0]?.id,
		)
		strictEqual(new Set(ids).size, 2)
		deepStrictEqual(
			ids,
			signals.map(
				(signal) =>
					evaluate("gitlab.project.lifecycle", "gitlab-project-updated", "project_update", signal)
						.events[0]?.id,
			),
		)
	})

	it("keeps the checked-in sample CloudEvents envelope-valid", () => {
		strictEqual(samples.length, 11)
		strictEqual(identities.length, samples.length)
		for (const [index, sample] of samples.entries()) {
			strictEqual(validateMapleCloudEvent(sample).event.id, sample.id)
			const identity = identities[index]!
			strictEqual(
				makeEventId({
					tenantId: "local",
					sourceKind: "otel.log",
					source: "https://gitlab.internal",
					occurrenceId: identity.occurrenceId,
					projectionId: identity.projectionId,
					projectionRevision: 1,
				}),
				sample.id,
			)
		}
	})
})

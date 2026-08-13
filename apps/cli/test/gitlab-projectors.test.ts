import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { describe, it } from "vitest"
import {
	CompiledProjectionRegistry,
	ProjectorRegistry,
	SignalSourceRegistry,
	validateMapleCloudEvent,
	type SignalPredicate,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import samples from "./fixtures/gitlab-projectors.v1.json"
import {
	gitlabMergeRequestLifecycleProjector,
	gitlabPipelineCompletedProjector,
	gitlabProjectLifecycleProjector,
	registerGitLabProjectors,
} from "../src/server/eventing/gitlab-projectors"
import { OTLP_LOG_ADAPTER, normalizeOtlpLogs } from "../src/server/eventing/otlp"

const stringAttr = (key: string, value: string) => ({ key, value: { stringValue: value } })
const intAttr = (key: string, value: string) => ({ key, value: { intValue: value } })

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
		throws(
			() => gitlabProjectLifecycleProjector.decodeConfig({ includeBody: true }),
			/gitlab\.project\.lifecycle projector config contains unknown fields/,
		)
	})

	it("keeps the checked-in sample CloudEvents envelope-valid", () => {
		strictEqual(samples.length, 3)
		for (const sample of samples) strictEqual(validateMapleCloudEvent(sample).event.id, sample.id)
	})
})

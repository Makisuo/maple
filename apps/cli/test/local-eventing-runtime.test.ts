import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import type { SignalProjectionSpec } from "@maple/eventing-core"
import { LocalEventingControlStore } from "../src/server/eventing/control-store"
import { normalizeOtlpLogs } from "../src/server/eventing/otlp"
import { LocalEventingRuntime } from "../src/server/eventing/runtime"
import { encodeLogs } from "../src/server/otlp/encode"

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-eventing-runtime-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const attr = (key: string, value: Record<string, unknown>) => ({ key, value })

const gitlabIssueCreated = {
	resourceLogs: [
		{
			resource: {
				attributes: [
					attr("service.name", { stringValue: "gitlab-rails" }),
					attr("service.version", { stringValue: "19.1.0" }),
				],
			},
			scopeLogs: [
				{
					scope: { name: "gitlab.event_store", version: "1.0.0" },
					logRecords: [
						{
							timeUnixNano: "1786131720123456789",
							observedTimeUnixNano: "1786131721123456789",
							eventName: "gitlab.issue.created",
							severityNumber: 9,
							severityText: "INFO",
							body: { stringValue: "Issue 42 created" },
							attributes: [
								attr("event.id", { stringValue: "01K20GITLABISSUE42" }),
								attr("event.source", { stringValue: "https://gitlab.internal" }),
								attr("gitlab.project.id", { intValue: "7" }),
								attr("gitlab.project.path", { stringValue: "platform/maple" }),
								attr("gitlab.issue.id", { intValue: "4200" }),
								attr("gitlab.issue.iid", { intValue: "42" }),
								attr("gitlab.issue.title", { stringValue: "Wire GitLab events" }),
								attr("gitlab.issue.url", {
									stringValue: "https://gitlab.internal/platform/maple/-/issues/42",
								}),
								attr("gitlab.user.id", { intValue: "9" }),
								attr("gitlab.user.username", { stringValue: "operator" }),
							],
						},
					],
				},
			],
		},
	],
}

const firstLogRecord = (request: typeof gitlabIssueCreated) =>
	request.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "gitlab-issue-created",
	revision: 1,
	enabled: true,
	tenantId: "local",
	sourceKind: "otel.log",
	selector: {
		op: "all",
		clauses: [
			{
				op: "eq",
				field: { namespace: "signal", key: "event.name", type: "string" },
				value: { type: "string", value: "gitlab.issue.created" },
			},
			{
				op: "gte",
				field: { namespace: "attribute", key: "gitlab.issue.iid", type: "int64" },
				value: { type: "int64", value: "1" },
			},
		],
	},
	projector: { id: "gitlab.issue.created", version: 1, config: {} },
	activeFrom: "2000-01-01T00:00:00Z",
	...overrides,
})

describe("LocalEventingRuntime", () => {
	it("normalizes typed GitLab OTLP fields while preserving the existing warehouse encoding", () => {
		const [signal] = normalizeOtlpLogs(gitlabIssueCreated, "2026-08-07T20:00:00Z")
		strictEqual(signal?.occurrenceId, "01K20GITLABISSUE42")
		strictEqual(signal?.identityQuality, "source")
		strictEqual(signal?.source, "https://gitlab.internal")
		deepStrictEqual(signal?.fields.get("attribute:gitlab.issue.iid"), {
			type: "int64",
			value: "42",
		})
		const batches = encodeLogs(gitlabIssueCreated)
		strictEqual(batches.length, 1)
		strictEqual(batches[0]?.rowCount, 1)
		strictEqual(JSON.parse(batches[0]!.ndjson).log_attributes["gitlab.issue.iid"], "42")
	})

	it("uses the first nonblank occurrence alias and derives identity when every alias is blank", () => {
		const aliased = structuredClone(gitlabIssueCreated)
		const aliasedRecord = firstLogRecord(aliased)
		aliasedRecord.attributes = [
			attr("event.id", { stringValue: "   " }),
			attr("cloudevents.id", { stringValue: " cloud-event-42 " }),
			attr("gitlab.event.id", { stringValue: "gitlab-event-42" }),
			...aliasedRecord.attributes.filter(
				({ key }) => !["event.id", "cloudevents.id", "gitlab.event.id"].includes(key),
			),
		]
		const [aliasedSignal] = normalizeOtlpLogs(aliased, "2026-08-07T20:00:00Z")
		strictEqual(aliasedSignal?.occurrenceId, "cloud-event-42")
		strictEqual(aliasedSignal?.identityQuality, "source")

		const derivedA = structuredClone(aliased)
		const derivedARecord = firstLogRecord(derivedA)
		derivedARecord.attributes = derivedARecord.attributes.map((entry) =>
			["event.id", "cloudevents.id", "gitlab.event.id"].includes(entry.key)
				? attr(entry.key, { stringValue: entry.key === "event.id" ? "" : " \t " })
				: entry,
		)
		const derivedB = structuredClone(derivedA)
		firstLogRecord(derivedB).body = { stringValue: "A different issue occurrence" }
		const [signalA] = normalizeOtlpLogs(derivedA, "2026-08-07T20:00:00Z")
		const [signalB] = normalizeOtlpLogs(derivedB, "2026-08-07T20:00:00Z")
		strictEqual(signalA?.identityQuality, "derived")
		strictEqual(signalB?.identityQuality, "derived")
		strictEqual(signalA?.occurrenceId?.startsWith("derived:sha256:"), true)
		strictEqual(signalA?.occurrenceId === signalB?.occurrenceId, false)
	})

	it("catalogs only the scalar body field that the OTLP adapter can populate", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store)
				throws(
					() =>
						runtime.prepareActivation(
							projection({
								selector: {
									op: "exists",
									field: { namespace: "body", key: "text", type: "string" },
								},
							}),
						),
					/unknown field body:text/,
				)
				const activation = runtime.prepareActivation(
					projection({
						selector: {
							op: "exists",
							field: { namespace: "body", key: "value", type: "boolean" },
						},
					}),
				)
				strictEqual(activation.spec.selector.op, "exists")
			} finally {
				store.close()
			}
		}))

	it("projects before storage, deduplicates retry delivery, and makes the event ready after commit", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store)
				strictEqual(runtime.hasActiveSource("otel.log"), false)
				runtime.activate(projection())
				const first = runtime.evaluateOtlp("logs", gitlabIssueCreated)
				strictEqual(first.failures.length, 0)
				strictEqual(first.events.length, 1)
				deepStrictEqual(first.events[0], {
					specversion: "1.0",
					id: first.events[0]!.id,
					source: "https://gitlab.internal",
					type: "dev.maple.gitlab.issue.created.v1",
					subject: "platform/maple/issues/42",
					time: "2026-08-07T19:42:00.123456789Z",
					datacontenttype: "application/json",
					dataschema: "urn:maple:event-schema:gitlab-issue-created:v1",
					tenantid: "local",
					projectionid: "gitlab-issue-created",
					projectionrevision: 1,
					projectorid: "gitlab.issue.created",
					projectorversion: 1,
					sourceoccurrenceid: "01K20GITLABISSUE42",
					sourceidentityquality: "source",
					data: {
						project: { id: "7", path: "platform/maple" },
						issue: {
							id: "4200",
							iid: "42",
							title: "Wire GitLab events",
							url: "https://gitlab.internal/platform/maple/-/issues/42",
						},
						actor: { id: "9", username: "operator" },
						serviceName: "gitlab-rails",
					},
				})
				const staged = runtime.stage(first.events)
				strictEqual(staged.inserted, 1)
				strictEqual(runtime.listReady().events.length, 0)
				deepStrictEqual(
					runtime.listStaged().events.map(({ event }) => event),
					first.events,
				)
				const retry = runtime.evaluateOtlp("logs", gitlabIssueCreated)
				strictEqual(retry.events[0]?.id, first.events[0]?.id)
				strictEqual(runtime.stage(retry.events).deduplicated, 1)
				runtime.markReady(staged.eventIds)
				deepStrictEqual(
					runtime.listReady().events.map(({ event }) => event),
					first.events,
				)
				deepStrictEqual(runtime.listStaged().events, [])
			} finally {
				store.close()
			}
		}))

	it("activates a validated revision without restart and reloads it after restart", async () =>
		withDataDir(async (dataDir) => {
			let store = await LocalEventingControlStore.open(dataDir)
			let runtime = new LocalEventingRuntime(store)
			runtime.activate(projection())
			strictEqual(runtime.evaluateOtlp("logs", gitlabIssueCreated).events.length, 1)
			runtime.activate(
				projection({
					revision: 2,
					selector: {
						op: "eq",
						field: { namespace: "signal", key: "event.name", type: "string" },
						value: { type: "string", value: "gitlab.issue.closed" },
					},
				}),
			)
			strictEqual(runtime.evaluateOtlp("logs", gitlabIssueCreated).events.length, 0)
			store.close()

			store = await LocalEventingControlStore.open(dataDir)
			try {
				runtime = new LocalEventingRuntime(store)
				strictEqual(runtime.listActive()[0]?.revision, 2)
				strictEqual(runtime.evaluateOtlp("logs", gitlabIssueCreated).events.length, 0)
			} finally {
				store.close()
			}
		}))

	it("does no normalization or event work for a source with no active projection", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store)
				deepStrictEqual(runtime.evaluateOtlp("logs", { malformed: Symbol("not decoded") }), {
					events: [],
					failures: [],
					typeMismatchFields: [],
				})
			} finally {
				store.close()
			}
		}))
})

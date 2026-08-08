import { describe, expect, it } from "vitest"
import {
	CompiledProjectionRegistry,
	canonicalJson,
	defineSignalFields,
	makeEventId,
	ProjectorRegistry,
	SignalSourceRegistry,
	type NormalizedSignal,
	type SignalProjectionSpec,
} from "./index"

const signal = (overrides: Partial<NormalizedSignal> = {}): NormalizedSignal => ({
	sourceKind: "otel.log",
	source: "urn:maple:source:otel:local",
	tenantId: "tenant-a",
	occurrenceId: "event-123",
	identityQuality: "source",
	occurredAt: "2026-08-07T19:42:00.123456789Z",
	observedAt: "2026-08-07T19:42:01Z",
	subject: "project/example/issues/42",
	fields: defineSignalFields([
		{
			field: { namespace: "attribute", key: "event.name", type: "string" },
			value: { type: "string", value: "gitlab.issue.created" },
		},
	]),
	data: { issue: { iid: 42, title: "Example" } },
	...overrides,
})

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "gitlab-issue-created",
	revision: 3,
	enabled: true,
	tenantId: "tenant-a",
	sourceKind: "otel.log",
	selector: {
		op: "eq",
		field: { namespace: "attribute", key: "event.name", type: "string" },
		value: { type: "string", value: "gitlab.issue.created" },
	},
	projector: { id: "gitlab.issue", version: 1, config: { includeTitle: true } },
	activeFrom: "2026-08-07T00:00:00Z",
	...overrides,
})

const projectors = (): ProjectorRegistry =>
	new ProjectorRegistry().register({
		id: "gitlab.issue",
		version: 1,
		sourceKinds: ["otel.log"],
		outputType: "dev.maple.gitlab.issue.created.v1",
		dataSchema: "urn:maple:event-schema:gitlab-issue:v1",
		decodeConfig: (value) => {
			if (typeof value !== "object" || value === null) throw new Error("invalid projector config")
			return value
		},
		project: (input) => ({ data: input.data as { issue: { iid: number; title: string } } }),
	})

const sources = (): SignalSourceRegistry =>
	new SignalSourceRegistry().register({
		sourceKind: "otel.log",
		fields: [
			{
				field: { namespace: "attribute", key: "event.name", type: "string" },
				operators: ["exists", "eq", "neq", "contains", "in"],
				sensitivity: "public",
				replay: "coerced",
			},
		],
		openFields: [
			{
				namespace: "attribute",
				types: ["string", "boolean", "int64", "float64", "timestamp", "duration"],
				operators: ["exists", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"],
				sensitivity: "public",
				replay: "coerced",
			},
		],
	})

describe("CompiledProjectionRegistry", () => {
	it("canonicalizes JSON independently of object insertion order", () => {
		expect(canonicalJson({ z: 1, nested: { b: true, a: [2, 1] }, a: "first" })).toBe(
			'{"a":"first","nested":{"a":[2,1],"b":true},"z":1}',
		)
		const shared = { value: 1 }
		expect(canonicalJson({ left: shared, right: shared })).toBe(
			'{"left":{"value":1},"right":{"value":1}}',
		)
		const cyclic: { self?: unknown } = {}
		cyclic.self = cyclic
		expect(() => canonicalJson(cyclic as never)).toThrow("finite acyclic JSON")
		expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("finite acyclic JSON")
	})

	it("projects every match into a deterministic CloudEvent", () => {
		const registry = CompiledProjectionRegistry.compile([projection()], sources(), projectors())
		const first = registry.evaluate(signal())
		const second = registry.evaluate(signal())
		expect(first.failures).toEqual([])
		expect(first.events).toEqual(second.events)
		expect(first.events).toHaveLength(1)
		expect(first.events[0]).toMatchObject({
			specversion: "1.0",
			id: makeEventId({
				tenantId: "tenant-a",
				sourceKind: "otel.log",
				source: "urn:maple:source:otel:local",
				occurrenceId: "event-123",
				projectionId: "gitlab-issue-created",
				projectionRevision: 3,
			}),
			type: "dev.maple.gitlab.issue.created.v1",
			subject: "project/example/issues/42",
			projectionrevision: 3,
			data: signal().data,
		})
	})

	it("runs every matching projection from one immutable registry snapshot", () => {
		const registry = CompiledProjectionRegistry.compile(
			[projection(), projection({ id: "gitlab-issue-created-audit" })],
			sources(),
			projectors(),
		)
		const result = registry.evaluate(signal())
		expect(result.failures).toEqual([])
		expect(result.events.map(({ projectionid }) => projectionid)).toEqual([
			"gitlab-issue-created",
			"gitlab-issue-created-audit",
		])
	})

	it("runs all matching projections and isolates projector failures", () => {
		const registryDefinitions = projectors().register({
			id: "broken",
			version: 1,
			sourceKinds: ["otel.log"],
			outputType: "dev.maple.broken.v1",
			dataSchema: "urn:maple:event-schema:broken:v1",
			decodeConfig: () => ({}),
			project: () => {
				throw new Error("projector invariant failed")
			},
		})
		const registry = CompiledProjectionRegistry.compile(
			[
				projection(),
				projection({ id: "broken-projection", projector: { id: "broken", version: 1, config: {} } }),
			],
			sources(),
			registryDefinitions,
		)
		const result = registry.evaluate(signal())
		expect(result.events).toHaveLength(1)
		expect(result.failures).toEqual([
			expect.objectContaining({
				projectionId: "broken-projection",
				message: "projector invariant failed",
			}),
		])
	})

	it("isolates tenants, source kinds, activation time, and disabled revisions", () => {
		const registry = CompiledProjectionRegistry.compile(
			[
				projection(),
				projection({ id: "future", revision: 1, activeFrom: "2026-08-08T00:00:00Z" }),
				projection({ id: "disabled", revision: 1, enabled: false }),
				projection({ id: "other-tenant", revision: 1, tenantId: "tenant-b" }),
			],
			sources(),
			projectors(),
		)
		expect(registry.evaluate(signal()).events.map(({ projectionid }) => projectionid)).toEqual([
			"gitlab-issue-created",
		])
		expect(registry.evaluate(signal({ sourceKind: "otel.span" })).events).toEqual([])
	})

	it("requires occurrence identity for durable projection", () => {
		const registry = CompiledProjectionRegistry.compile([projection()], sources(), projectors())
		const result = registry.evaluate(signal({ occurrenceId: null, identityQuality: "none" }))
		expect(result.events).toEqual([])
		expect(result.failures[0]?.message).toBe(
			"durable event projection requires stable or derived occurrence identity",
		)
	})

	it("rejects duplicate registrations, projection revisions, and invalid projector bindings", () => {
		const definitions = projectors()
		expect(() =>
			definitions.register({
				id: "gitlab.issue",
				version: 1,
				sourceKinds: ["otel.log"],
				outputType: "duplicate",
				dataSchema: "duplicate",
				decodeConfig: (value) => value,
				project: () => ({ data: {} }),
			}),
		).toThrow("duplicate projector registration")
		expect(() =>
			CompiledProjectionRegistry.compile([projection(), projection()], sources(), projectors()),
		).toThrow("duplicate projection revision")
		expect(() =>
			CompiledProjectionRegistry.compile(
				[projection({ projector: { id: "missing", version: 1, config: {} } })],
				sources(),
				projectors(),
			),
		).toThrow("unregistered projector")
	})

	it("validates selector fields and operators against the source catalog", () => {
		const closed = new SignalSourceRegistry().register({
			sourceKind: "otel.log",
			fields: [
				{
					field: { namespace: "attribute", key: "event.name", type: "string" },
					operators: ["eq"],
					sensitivity: "public",
					replay: "coerced",
				},
			],
		})
		expect(() =>
			CompiledProjectionRegistry.compile(
				[
					projection({
						selector: {
							op: "contains",
							field: { namespace: "attribute", key: "event.name", type: "string" },
							value: { type: "string", value: "gitlab" },
						},
					}),
				],
				closed,
				projectors(),
			),
		).toThrow("contains is not allowed for catalog field")
		expect(() =>
			CompiledProjectionRegistry.compile(
				[
					projection({
						selector: {
							op: "eq",
							field: { namespace: "attribute", key: "unknown", type: "string" },
							value: { type: "string", value: "x" },
						},
					}),
				],
				closed,
				projectors(),
			),
		).toThrow("unknown field attribute:unknown")
	})
})

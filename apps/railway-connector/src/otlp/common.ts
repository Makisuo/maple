/**
 * Shared OTLP/JSON building blocks for the Railway connector.
 *
 * JSON shape contract — pinned by the Rust deserializer in `apps/ingest`
 * (`opentelemetry-proto` `with-serde`; see the `scraper_contract` test in
 * `apps/ingest/src/telemetry.rs`): camelCase field names, flattened oneofs
 * (`asDouble`, `stringValue`), and `timeUnixNano`/`startTimeUnixNano` as
 * STRINGS (custom u64-from-string).
 */

export interface OtlpKeyValue {
	readonly key: string
	readonly value: { readonly stringValue: string }
}

export interface RailwayResourceContext {
	/** Railway service name → `service.name` (drives the Maple service views). */
	readonly serviceName: string
	readonly serviceId: string
	readonly projectId: string
	readonly projectName: string | null
	readonly environmentId: string
	readonly environmentName: string | null
}

export const attribute = (key: string, value: string): OtlpKeyValue => ({
	key,
	value: { stringValue: value },
})

/**
 * One OTLP resource per Railway service so pulled telemetry shows up as
 * first-class services in Maple. The gateway strips/stamps `maple_org_id`
 * and `maple_ingest_source` itself — only the railway identity goes here.
 */
export const buildResourceAttributes = (context: RailwayResourceContext): OtlpKeyValue[] => [
	attribute("service.name", context.serviceName),
	...(context.projectName === null ? [] : [attribute("service.namespace", context.projectName)]),
	attribute("cloud.provider", "railway"),
	attribute("railway.project.id", context.projectId),
	...(context.projectName === null ? [] : [attribute("railway.project.name", context.projectName)]),
	attribute("railway.environment.id", context.environmentId),
	...(context.environmentName === null
		? []
		: [attribute("railway.environment.name", context.environmentName)]),
	attribute("railway.service.id", context.serviceId),
]

export const msToUnixNano = (ms: number): string => `${Math.round(ms)}000000`

import { randomUUID } from "node:crypto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { defineInstrumentation, isChannel } from "eve/instrumentation"
import slackChannel from "#channels/slack.js"
import { GenAiCostSpanProcessor } from "#lib/genai-cost.js"
import { markAgentTelemetryActive } from "#lib/telemetry-log.js"

/**
 * OpenTelemetry export to Maple's own ingest gateway — the eve-native port of
 * chat-flue's `setupTelemetry` (apps/chat-flue/src/lib/telemetry.ts). The
 * slack-agent is a long-running Node process on Railway, so a NodeSDK with the
 * default BatchSpanProcessor just works (none of chat-flue's workerd
 * flush/isolate pain applies).
 *
 * Disabled (no-op) when MAPLE_INGEST_KEY is unset, keeping local dev silent —
 * the same contract as chat-flue. `maple_org_id` is intentionally NOT set:
 * the ingest gateway strips client-supplied org attribution and injects it
 * from the ingest key.
 */

/** Service name stamped on every slack-agent span. */
export const SLACK_AGENT_SERVICE_NAME = "maple-slack-agent"

/** Default Maple ingest gateway (overridable via MAPLE_ENDPOINT). */
const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

/** Bound on the shutdown flush so a wedged exporter cannot block the exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000

/** Release attribution for one deployment (exported for tests). */
export interface ResourceAttributeInput {
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly commitSha?: string | undefined
}

/**
 * Resource attributes mirroring chat-flue's telemetry.ts (exported for
 * tests). The deployment environment is dual-emitted: Tinybird MVs still
 * pre-extract the legacy `deployment.environment`; keep both it and the
 * OTel-canonical `.name` until the MVs coalesce them.
 *
 * `service.version` + `deployment.commit_sha` are what tie a span back to a
 * release — Maple's own MV extracts CommitSha to power the commit-hover UI, so
 * omitting it makes this service the one that never shows a deploy marker.
 */
export function buildResourceAttributes(input: ResourceAttributeInput = {}): Record<string, string> {
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: SLACK_AGENT_SERVICE_NAME,
		"service.namespace": "core",
		"service.instance.id": randomUUID(),
		"service.version": input.serviceVersion?.trim() || "development",
		"maple.sdk.type": "eve",
		"vcs.repository.url.full": "https://github.com/MapleTechLabs/maple",
	} satisfies Record<string, string>
	if (input.commitSha?.trim()) {
		attributes["deployment.commit_sha"] = input.commitSha.trim()
	}
	if (input.environment) {
		attributes["deployment.environment"] = input.environment
		attributes["deployment.environment.name"] = input.environment
	}
	return attributes
}

function setupTelemetry(): void {
	const ingestKey = process.env.MAPLE_INGEST_KEY?.trim()
	if (!ingestKey) return

	const endpoint = (process.env.MAPLE_ENDPOINT?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/u, "")
	const environment =
		process.env.MAPLE_ENVIRONMENT?.trim() || process.env.RAILWAY_ENVIRONMENT_NAME?.trim() || undefined
	// Railway injects RAILWAY_GIT_COMMIT_SHA on every build from a repo.
	const commitSha =
		process.env.MAPLE_COMMIT_SHA?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined
	const serviceVersion = process.env.MAPLE_SERVICE_VERSION?.trim() || commitSha?.slice(0, 7)

	const headers = { Authorization: `Bearer ${ingestKey}` }
	const resource = resourceFromAttributes(
		buildResourceAttributes({ environment, serviceVersion, commitSha }),
	)

	const sdk = new NodeSDK({
		resource,
		// Every outbound call this agent makes — Slack Web API, the model gateway,
		// the Maple MCP server — is a global `fetch`, i.e. undici. Without this,
		// none of those calls produce a span, so a non-2xx response from any of
		// them (e.g. an MCP connection request) never carries an HTTP status into
		// Maple's own telemetry. undici is instrumented through
		// diagnostics_channel, so unlike the module-patching instrumentations this
		// needs no loader hook and survives eve's bundled build. It cannot
		// recurse into the exporters below: the Node OTLP exporters use
		// `node:http`, not fetch.
		instrumentations: [new UndiciInstrumentation()],
		// Explicit processor list instead of `traceExporter` (which would build
		// just the batch processor): the cost processor must see each span before
		// the batch processor serializes it, so it can lift OpenRouter's charged
		// cost from `ai.response.providerMetadata` into `gen_ai.usage.cost`.
		spanProcessors: [
			new GenAiCostSpanProcessor(),
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: `${endpoint}/v1/traces`,
					headers,
				}),
			),
		],
		// Logs, not just spans: agent/hooks/outcome-log.ts is the primary signal
		// for the "agent did nothing" failure mode, and without a log pipeline it
		// never leaves the container. NodeSDK builds the LoggerProvider from these
		// processors with the same resource and registers it globally.
		logRecordProcessors: [
			new BatchLogRecordProcessor({
				exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
			}),
		],
	})
	sdk.start()
	markAgentTelemetryActive()

	// Flush spans AND logs on shutdown so the tail of a deploy isn't lost when
	// Railway stops the container. Registering a SIGTERM listener overrides
	// Node's default terminate-on-SIGTERM, so this handler now owns the exit:
	// it must await the flush and then exit itself, or the container hangs until
	// Railway escalates to SIGKILL — the exact loss this is meant to prevent.
	let shuttingDown = false
	const handleSignal = (signal: "SIGTERM" | "SIGINT"): void => {
		if (shuttingDown) return
		shuttingDown = true
		const exitCode = signal === "SIGINT" ? 130 : 143
		void Promise.race([
			sdk.shutdown(),
			new Promise((resolve) => {
				const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
				timer.unref?.()
			}),
		])
			.catch((error: unknown) => {
				console.error("[slack-agent] OTel shutdown failed", error)
			})
			.finally(() => {
				process.exit(exitCode)
			})
	}
	process.once("SIGTERM", () => handleSignal("SIGTERM"))
	process.once("SIGINT", () => handleSignal("SIGINT"))
}

export default defineInstrumentation({
	setup: () => setupTelemetry(),
	// Record full message content (prompts + model outputs) on the AI SDK
	// telemetry spans. Deliberate reversal of the earlier privacy stance
	// (2026-08-06): the agentic-tracing work needs real message payloads in
	// the gen_ai spans. Note this puts customer Slack message history and
	// model outputs into the telemetry warehouse.
	recordInputs: true,
	recordOutputs: true,
	events: {
		"step.started"(input) {
			// Slack-only runtime context so per-workspace latency/failures are
			// queryable — the analog of chat-flue's `chat.turn` span attributes.
			if (!isChannel(input.channel, slackChannel)) return undefined
			const metadata = input.channel.metadata
			// Built conditionally: `?? ""` would write real empty-string attribute
			// values into the warehouse, which are indistinguishable from a genuine
			// empty id and break `IS NULL`-style filtering.
			const runtimeContext: Record<string, string> = {}
			if (metadata.teamId) runtimeContext["maple.slack.team_id"] = metadata.teamId
			if (metadata.channelId) {
				runtimeContext["maple.slack.channel_id"] = metadata.channelId
			}
			if (metadata.threadTs) {
				runtimeContext["maple.slack.thread_ts"] = metadata.threadTs
			}
			if (metadata.triggeringUserId) {
				runtimeContext["maple.slack.user_id"] = metadata.triggeringUserId
			}
			return { runtimeContext }
		},
	},
})

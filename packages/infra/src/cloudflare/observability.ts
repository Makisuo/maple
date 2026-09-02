import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import { requiredPlain } from "../env.ts"
import { MapleStack } from "./stack.ts"

/**
 * Workers Observability destinations for the asset Workers' platform logs and
 * traces (`landing`, `local-ui`): OTLP into Maple's own ingest. Account-wide,
 * so they exist in production only and are `retain`ed — the other stages fall
 * back to the `maple` destination slug until production has deployed them.
 * Yielded from each Worker module that references them; alchemy registers a
 * resource by id, so the second yield returns the first's.
 */
export const WorkersObservabilityDestinations = Effect.gen(function* () {
	const { stage } = yield* MapleStack
	if (stage.kind !== "prd") {
		return { logsDestination: undefined, tracesDestination: undefined }
	}

	const ingestEndpoint = (process.env.MAPLE_ENDPOINT?.trim() || "https://ingest.maple.dev").replace(
		/\/+$/,
		"",
	)
	const headers = { authorization: `Bearer ${yield* requiredPlain("MAPLE_OTEL_INGEST_KEY")}` }
	const tracesDestination = yield* Cloudflare.Workers.ObservabilityDestination(
		"workers-observability-traces",
		{
			name: "maple-workers-traces",
			url: `${ingestEndpoint}/v1/traces`,
			headers,
			logpushDataset: "opentelemetry-traces",
			enabled: true,
		},
	).pipe(RemovalPolicy.retain())
	const logsDestination = yield* Cloudflare.Workers.ObservabilityDestination("workers-observability-logs", {
		name: "maple-workers-logs",
		url: `${ingestEndpoint}/v1/logs`,
		headers,
		logpushDataset: "opentelemetry-logs",
		enabled: true,
	}).pipe(RemovalPolicy.retain())

	return { logsDestination, tracesDestination }
})

/**
 * The `observability` block the asset Workers share: invocation logs on,
 * traces off — Cloudflare marks every non-2xx `fetch` span `Error`, so bot
 * 404s (`/wp-admin`, `/.git/config`) flooded error issues with "Unknown Error".
 */
export const assetWorkerObservability = ({
	logsDestination,
	tracesDestination,
}: Effect.Success<typeof WorkersObservabilityDestinations>) => ({
	enabled: true,
	logs: {
		enabled: true,
		invocationLogs: true,
		destinations: [logsDestination?.slug ?? "maple"],
	},
	traces: {
		enabled: false,
		destinations: [tracesDestination?.slug ?? "maple"],
	},
})

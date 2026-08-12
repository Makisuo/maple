import { Clock, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

export interface IngestConnection {
	/** `connected` once non-demo telemetry is observed in the last hour. */
	status: "waiting" | "connected"
	/** Count of real (non-`demo-`) services seen. */
	serviceCount: number
	/** First real service name, if any — handy for "we're seeing X" copy. */
	firstRealService?: string
	/** Spans per minute across real services, averaged over the 1h window. */
	spansPerMinute: number
	/** The org's public ingest key (empty string until loaded / when denied). */
	apiKey: string
	/** Force an immediate re-poll of the service overview. */
	refresh: () => void
}

interface UseIngestConnectionOptions {
	/** Poll the service overview on an interval (default: true). */
	poll?: boolean
}

/**
 * Live ingest-connection state, shared across the Connect popover, ingestion
 * settings, and the dashboard setup checklist. Polls the service overview and
 * filters out the seeded `demo-` services so the signal reflects the user's own
 * telemetry. Reuses the cached `ingestKeys` query for the public key.
 */
export function useIngestConnection({ poll = true }: UseIngestConnectionOptions = {}): IngestConnection {
	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")

	const keysResult = useAtomValue(retainedQueryV2("ingestKeys", "retrieve", {}))
	const apiKey = Result.isSuccess(keysResult) ? keysResult.value.public_key : ""

	const overviewAtom = getServiceOverviewResultAtom({ data: { startTime, endTime } })
	const overviewResult = useAtomValue(overviewAtom)
	const refresh = useAtomRefresh(overviewAtom)

	// Keep the connection signal warm while the popover/checklist is mounted.
	useIntervalRefresh(refresh, { intervalMs: 15000, enabled: poll })

	const services = Result.isSuccess(overviewResult) ? overviewResult.value.data : []
	const realServices = services.filter(
		(s) => !(typeof s.serviceName === "string" && s.serviceName.startsWith("demo-")),
	)
	const firstRealService =
		typeof realServices[0]?.serviceName === "string" ? (realServices[0].serviceName as string) : undefined
	const spansPerMinute = realServices.reduce((sum, s) => sum + (s.spanCount ?? 0), 0) / 60

	return {
		status: realServices.length > 0 ? "connected" : "waiting",
		serviceCount: realServices.length,
		firstRealService,
		spansPerMinute,
		apiKey,
		refresh,
	}
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

const TEST_EVENT_SERVICE = "maple-onboarding-test"

class TestEventIngestRejected extends Schema.TaggedError<TestEventIngestRejected>()(
	"@maple/web/TestEventIngestRejected",
	{
		message: Schema.String,
		status: Schema.Number,
	},
) {}

export const sendTestEventEffect = Effect.fn("Onboarding.sendTestEvent")(function* (apiKey: string) {
	const now = yield* Clock.currentTimeMillis
	const endNano = `${now}000000`
	const startNano = `${now - 87}000000`
	const payload = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: TEST_EVENT_SERVICE } },
						{ key: "deployment.environment", value: { stringValue: "development" } },
					],
				},
				scopeSpans: [
					{
						scope: { name: "maple-onboarding" },
						spans: [
							{
								traceId: randomHex(16),
								spanId: randomHex(8),
								name: "GET /maple/test-event",
								kind: 2,
								startTimeUnixNano: startNano,
								endTimeUnixNano: endNano,
								attributes: [
									{ key: "http.request.method", value: { stringValue: "GET" } },
									{ key: "http.route", value: { stringValue: "/maple/test-event" } },
									{ key: "http.response.status_code", value: { intValue: 200 } },
								],
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	}

	const client = yield* HttpClient.HttpClient
	const request = yield* HttpClientRequest.bodyJson(
		HttpClientRequest.post(`${ingestUrl}/v1/traces`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		}),
		payload,
	)
	const response = yield* client.execute(request)
	// HttpClient does not fail on non-2xx, so surface it explicitly — runPromise
	// rejects, preserving the throw-on-failure contract the click handler relies on.
	if (response.status < 200 || response.status >= 300) {
		return yield* new TestEventIngestRejected({
			message: `Ingest gateway returned ${response.status}`,
			status: response.status,
		})
	}
})

/** POST a single synthetic trace to the ingest gateway to prove the key works. */
export const sendTestEvent = (apiKey: string): Promise<void> =>
	sendTestEventEffect(apiKey).pipe(
		// This is the Promise bridge used by click handlers, so it owns the HTTP layer.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(FetchHttpClient.layer),
		Effect.runPromise,
	)

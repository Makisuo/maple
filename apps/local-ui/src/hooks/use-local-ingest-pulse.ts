import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { parseClickHouseDateTime, toClickHouseDateTime } from "../lib/time"

// Bound the scan to a recent window — "idle" simply means nothing arrived this
// recently. Poll a few times a minute; the query is a group-less aggregate so
// it's effectively free.
const WINDOW_MS = 10 * 60 * 1000
const POLL_MS = 5_000
// Abort the probe if the binary accepts the connection but never answers (chDB
// runs synchronously over FFI, so a stuck query can hang the response). This
// turns a hang into an error, which the connection gate reads as "disconnected"
// instead of an indefinite skeleton.
const PROBE_TIMEOUT_MS = 3_000

export interface IngestPulse {
	/** Epoch-ms of the most recent span/log in the window, or null if none. */
	lastSeenMs: number | null
	/** Total spans + logs ingested within the window. */
	recentCount: number
}

/**
 * Polls the local binary for a live "are we receiving telemetry" signal that
 * drives the header heartbeat. Unions a span + log probe (see
 * `orgTelemetryPulseQuery`) over a recent window and reduces it to the latest
 * timestamp seen.
 */
export function useLocalIngestPulse() {
	return useQuery<IngestPulse>({
		queryKey: ["local", "ingest-pulse"],
		refetchInterval: POLL_MS,
		staleTime: 0,
		// The 5s poll is our recovery loop — don't pile retries on a down binary.
		retry: false,
		queryFn: async () => {
			const now = Date.now()
			const compiled = CH.compileUnion(CH.orgTelemetryPulseQuery(), {
				orgId: LOCAL_ORG_ID,
				startTime: toClickHouseDateTime(now - WINDOW_MS),
				endTime: toClickHouseDateTime(now + 60 * 1000),
			})
			const rows = await executeLocalCompiledQuery(compiled, AbortSignal.timeout(PROBE_TIMEOUT_MS))

			const active = rows.filter((row) => row.count > 0)
			const recentCount = active.reduce((sum, row) => sum + row.count, 0)
			const lastSeenMs = active.reduce<number | null>((latest, row) => {
				const ms = parseClickHouseDateTime(row.lastSeen)
				if (ms === null) return latest
				return latest === null || ms > latest ? ms : latest
			}, null)

			return { lastSeenMs, recentCount }
		},
	})
}

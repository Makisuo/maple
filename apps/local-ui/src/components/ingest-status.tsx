// Header heartbeat — a live signal that the local collector is receiving
// telemetry. Reuses the Sessions "active" ping treatment so a running local
// stack reads the same across the app. Polls via `useLocalIngestPulse`.

import type { ReactNode } from "react"
import { ConnectionIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/utils"
import { LOCAL_OTLP_ENDPOINT } from "../lib/constants"
import { formatRelativeMs } from "../lib/time"
import { useLocalIngestPulse } from "../hooks/use-local-ingest-pulse"

// Data newer than this reads as "live"; the poll cadence keeps it honest.
const FRESH_MS = 15_000

function ingestPort(url: string): string {
	try {
		return new URL(url).port || "4318"
	} catch {
		return "4318"
	}
}

export function IngestStatus() {
	const { data, isError } = useLocalIngestPulse()
	const lastSeenMs = data?.lastSeenMs ?? null
	const isLive = lastSeenMs !== null && Date.now() - lastSeenMs < FRESH_MS

	if (isLive) {
		return (
			<Pill tone="live" title={`Last telemetry ${formatRelativeMs(lastSeenMs)}`}>
				<LiveDot />
				Receiving
			</Pill>
		)
	}

	if (lastSeenMs !== null && !isError) {
		return (
			<Pill tone="idle" title="Connected — no telemetry in the last few minutes">
				<span className="size-1.5 rounded-full bg-muted-foreground/40" />
				Last data {formatRelativeMs(lastSeenMs)}
			</Pill>
		)
	}

	// No recent data, or the local server isn't reachable yet — either way we're
	// waiting on the ingest endpoint.
	return (
		<Pill tone="idle" title={isError ? "Waiting for the local collector" : "Waiting for telemetry"}>
			<ConnectionIcon size={13} className="text-muted-foreground" />
			Listening on :{ingestPort(LOCAL_OTLP_ENDPOINT)}
		</Pill>
	)
}

function Pill({ tone, title, children }: { tone: "live" | "idle"; title?: string; children: ReactNode }) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums",
				tone === "live"
					? "border-success/30 bg-success/10 text-success"
					: "border-border bg-muted/40 text-muted-foreground",
			)}
		>
			{children}
		</span>
	)
}

function LiveDot() {
	return (
		<span className="relative flex size-1.5">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-success" />
		</span>
	)
}

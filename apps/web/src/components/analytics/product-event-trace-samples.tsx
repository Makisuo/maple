import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { productEventTraceSamplesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { ChartBarTrendUpIcon } from "@/components/icons"

/**
 * Recent traces behind one product event. Renders nothing when empty (browser
 * and `/v1/events` rows carry no trace, so "none" is not a finding), but a
 * failure is shown: the user filtered to this event and asked.
 */
export function ProductEventTraceSamples({
	eventName,
	startTime,
	endTime,
}: {
	eventName: string
	startTime: string
	endTime: string
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const result = useAtomValue(
		productEventTraceSamplesResultAtom({ data: { eventName, startTime, endTime, limit: 10 } }),
	)

	return Result.builder(result)
		.onSuccess((response) => {
			if (response.data.length === 0) return null
			return (
				<section className="rounded-md border bg-card">
					<header className="flex items-center gap-2 border-b px-3 py-2">
						<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
						<h2 className="text-xs font-medium">Traces behind “{eventName}”</h2>
					</header>
					<ul className="divide-y">
						{/* Index included: at-least-once ingest can duplicate a row, and
						    one trace can fire the event from several spans. */}
						{response.data.map((sample, index) => (
							<li key={`${index}:${sample.traceId}:${sample.spanId}`}>
								<Link
									to="/traces/$traceId"
									params={{ traceId: sample.traceId }}
									// `spanId` selects the annotated span in the waterfall and
									// `t` narrows the partition scan to a ±1h window — without it
									// the hierarchy query reads every retained daily partition.
									search={{ spanId: sample.spanId, t: sample.timestamp }}
									className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
								>
									<span className="font-mono text-muted-foreground">
										{sample.traceId.slice(0, 8)}
									</span>
									{sample.serviceName === "" ? null : <span>{sample.serviceName}</span>}
									{sample.userId || sample.visitorId ? (
										<span className="text-muted-foreground">
											· {sample.userId || sample.visitorId}
										</span>
									) : null}
									<span className="ml-auto text-muted-foreground">
										{formatTimestampInTimezone(sample.timestamp, {
											timeZone: effectiveTimezone,
										})}
									</span>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)
		})
		.onError(() => (
			<section className="rounded-md border bg-card">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
					<h2 className="text-xs font-medium">Traces behind “{eventName}”</h2>
				</header>
				<p className="px-3 py-2 text-xs text-muted-foreground">
					Could not load traces for this event. This is a query failure, not an empty result —
					reload to try again.
				</p>
			</section>
		))
		.orElse(() => null)
}

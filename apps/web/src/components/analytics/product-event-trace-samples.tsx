import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { productEventTraceSamplesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { ChartBarTrendUpIcon } from "@/components/icons"

/**
 * Recent traces behind one product event — the other half of the link a
 * `maple.product_event.name` span attribute creates.
 *
 * Only events annotated on a span can answer this. A `track()` call from the
 * browser and a `POST /v1/events` row carry no trace, so for those the list is
 * empty and this renders nothing rather than an empty state: "no traces" is not
 * a finding about the event, it just means the event was not emitted from a
 * span, and saying so on every browser event would be noise on the majority of
 * them.
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
				<section className="rounded-md border">
					<header className="flex items-center gap-2 border-b px-3 py-2">
						<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
						<h2 className="text-xs font-medium">Traces behind “{eventName}”</h2>
					</header>
					<ul className="divide-y">
						{response.data.map((sample) => (
							<li key={`${sample.traceId}:${sample.spanId}`}>
								<Link
									to="/traces/$traceId"
									params={{ traceId: sample.traceId }}
									// `spanId` selects the annotated span in the waterfall and
									// `t` narrows the partition scan to a ±1h window — without it
									// the hierarchy query reads every retained daily partition.
									search={{ spanId: sample.spanId, t: sample.timestamp }}
									className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted"
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
		.onError(() => null)
		.orElse(() => null)
}

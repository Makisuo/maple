import { useMemo } from "react"
import { useTimeDisplay } from "@maple/ui/lib/time-display-context"
import {
	formatBucketLabel,
	formatCompactTime,
	formatDateTime,
	formatDayHeading,
	formatOffsetLabel,
	formatTimeOfDay,
	formatTimestamp,
	getOffsetMinutes,
	type TimeZoneId,
} from "@maple/ui/lib/time-format"

type TimeFormatInput = string | number | Date

/**
 * The easy (and only correct) path for absolute-time display: reads the active
 * display timezone from context and returns formatters already bound to it, so
 * callers never touch a raw `TimeZoneId`. `timeZone` is exposed for the rare
 * pure-callback sites (e.g. recharts `tickFormatter`) that need to pass it to
 * `formatBucketLabel` directly.
 */
export function useTimeFormat() {
	const { timeZone } = useTimeDisplay()

	return useMemo(
		() => ({
			timeZone,
			formatTimestamp: (input: TimeFormatInput, options?: { withMilliseconds?: boolean }) =>
				formatTimestamp(input, { timeZone, withMilliseconds: options?.withMilliseconds }),
			formatTimeOfDay: (input: TimeFormatInput, options?: { withSeconds?: boolean }) =>
				formatTimeOfDay(input, { timeZone, withSeconds: options?.withSeconds }),
			formatCompactTime: (input: TimeFormatInput) => formatCompactTime(input, { timeZone }),
			formatDateTime: (
				input: TimeFormatInput,
				options?: { year?: boolean; seconds?: boolean; dateOnly?: boolean },
			) =>
				formatDateTime(input, {
					timeZone,
					year: options?.year,
					seconds: options?.seconds,
					dateOnly: options?.dateOnly,
				}),
			formatDayHeading: (input: TimeFormatInput) => formatDayHeading(input, { timeZone }),
			formatBucketLabel: (
				value: unknown,
				context: { rangeMs: number; bucketSeconds: number | undefined },
				mode: "tick" | "tooltip",
			) => formatBucketLabel(value, context, mode, timeZone),
			formatOffsetLabel: (at?: Date) => formatOffsetLabel(timeZone, at),
			getOffsetMinutes: (at?: Date) => getOffsetMinutes(timeZone, at),
		}),
		[timeZone],
	)
}

export type { TimeZoneId }

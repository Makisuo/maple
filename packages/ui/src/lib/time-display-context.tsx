"use client"

import * as React from "react"
import { browserTimeZoneId, type TimeZoneId } from "./time-format"

/**
 * The active display timezone for all absolute-time rendering. Apps wire this
 * once at the root via `TimeDisplayProvider`, fed by the user's timezone
 * preference; charts and the `useTimeFormat()` hook read it here so no consumer
 * needs its own atom subscription. Defaults to the browser zone.
 */
const TimeDisplayContext = React.createContext<TimeZoneId>(browserTimeZoneId())

export function TimeDisplayProvider({
	timeZone,
	children,
}: {
	timeZone: TimeZoneId
	children: React.ReactNode
}) {
	return <TimeDisplayContext value={timeZone}>{children}</TimeDisplayContext>
}

export function useTimeDisplay(): { timeZone: TimeZoneId } {
	const timeZone = React.use(TimeDisplayContext)
	return React.useMemo(() => ({ timeZone }), [timeZone])
}

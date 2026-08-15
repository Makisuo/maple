/**
 * `$__startTime` / `$__endTime` substitution in widget data-source params.
 *
 * Split out of the web app's widget hook so the API can interpolate a stored
 * widget's params identically. A shared dashboard's queries are built on the
 * server, and if the two hosts disagreed about what `$__startTime` means, the
 * same widget would query a different window depending on who was looking at
 * it — the kind of divergence that only shows up as "the numbers are different
 * on the share link".
 *
 * Deliberately narrow. It replaces only a value that is *exactly* the macro,
 * never a substring, which is what keeps it from touching a raw-SQL body where
 * `$__timeFilter(...)`-style macros are expanded much later by the backend.
 * Dashboard *variable* refs (`$name` / `${name}`) are a separate pass —
 * `interpolateWidgetParams` in `./interpolate` — and always run after this one.
 */

export interface ResolvedWindow {
	readonly startTime: string
	readonly endTime: string
}

export const START_TIME_MACRO = "$__startTime"
export const END_TIME_MACRO = "$__endTime"

export function interpolateTimeMacros(
	params: Record<string, unknown>,
	window: ResolvedWindow,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(params)) {
		if (typeof value === "string") {
			if (value === START_TIME_MACRO) {
				result[key] = window.startTime
			} else if (value === END_TIME_MACRO) {
				result[key] = window.endTime
			} else {
				result[key] = value
			}
		} else {
			result[key] = value
		}
	}

	return result
}

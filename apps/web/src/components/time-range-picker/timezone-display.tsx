import { getTimezoneDisplay, getTimezoneAbbr } from "@/lib/time-utils"

export function TimezoneDisplay() {
	const offset = getTimezoneDisplay()
	const abbr = getTimezoneAbbr()

	return (
		<div className="space-y-1">
			<div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Timezone</div>
			<div className="text-xs">
				<span className="font-medium">{offset}</span>
				<span className="text-muted-foreground ml-1">({abbr})</span>
			</div>
		</div>
	)
}

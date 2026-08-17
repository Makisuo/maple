import { useState } from "react"

import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import type { SpanNode } from "@maple/ui/lib/types"

import { TIMELINE_LAB_TRACE as DETAIL } from "@/lab/timeline-fixture"

export function TimelineLab() {
	const [selected, setSelected] = useState<SpanNode | undefined>(undefined)
	return (
		<div className="h-screen p-4">
			<TraceViewTabs
				rootSpans={DETAIL.rootSpans}
				spans={DETAIL.spans}
				totalDurationMs={DETAIL.totalDurationMs}
				traceStartTime={DETAIL.traceStartTime}
				services={DETAIL.services}
				selectedSpanId={selected?.spanId}
				onSelectSpan={setSelected}
			/>
		</div>
	)
}

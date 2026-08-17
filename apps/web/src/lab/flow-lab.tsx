import { useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TraceFlowView } from "@maple/ui/components/traces/flow-view"
import type { SpanNode } from "@maple/ui/lib/types"

import { FLOW_LAB_TRACE } from "@/lab/flow-fixture"

export function FlowLab() {
	const [selected, setSelected] = useState<SpanNode | undefined>(undefined)
	const detail = FLOW_LAB_TRACE

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Flow Lab" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="flex h-full flex-col">
							<div className="border-b px-4 py-3">
								<h1 className="text-sm font-semibold">Flow Lab</h1>
								<p className="text-xs text-muted-foreground">
									Synthetic trace exercising every Flow view card variant. Selected:{" "}
									<span className="font-mono">{selected?.spanName ?? "none"}</span>
								</p>
							</div>
							<div className="min-h-0 flex-1">
								<TraceFlowView
									rootSpans={detail.rootSpans}
									totalDurationMs={detail.totalDurationMs}
									traceStartTime={detail.traceStartTime}
									services={detail.services}
									selectedSpanId={selected?.spanId}
									onSelectSpan={setSelected}
								/>
							</div>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

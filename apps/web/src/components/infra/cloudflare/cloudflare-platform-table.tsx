// Workers-platform resources on the /infra/cloudflare index: Queues (backlog
// depth / consumer concurrency gauges) and Durable Objects (invocation
// counters on their implementing Worker). The whole section hides itself for
// accounts without either dataset — most orgs never see it.

import { Result, useAtomValue } from "@/lib/effect-atom"
import type { CloudflareDurableObjectRow, CloudflareQueueRow } from "@/api/warehouse/cloudflare-infra"
import { cloudflarePlatformResourcesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { ColumnHead, TableShell, useTableSort } from "../primitives/data-table"
import { formatPercent } from "../format"
import { errorRateClass } from "./constants"
import { formatBytes } from "./format"

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

const numCell = (value: string, hidden?: boolean) => (
	<div
		className={`w-[110px] text-right font-mono text-[12px] tabular-nums text-foreground/80 ${
			hidden ? "hidden md:block" : ""
		}`}
	>
		{value}
	</div>
)

type QueueSortKey = "queueName" | "backlogMessages" | "backlogMessagesMax" | "consumerConcurrency"

function QueueTable({ queues, waiting }: { queues: ReadonlyArray<CloudflareQueueRow>; waiting?: boolean }) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareQueueRow, QueueSortKey>(queues, {
		initialKey: "backlogMessagesMax",
		stringKeys: ["queueName"],
	})
	return (
		<TableShell
			ariaLabel="Cloudflare queues"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No queue activity in the selected window."
			header={
				<>
					<ColumnHead<QueueSortKey>
						label="Queue"
						sortKey="queueName"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="flex-1 min-w-[220px]"
					/>
					<ColumnHead<QueueSortKey>
						label="Backlog avg"
						sortKey="backlogMessages"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[110px]"
					/>
					<ColumnHead<QueueSortKey>
						label="Backlog peak"
						sortKey="backlogMessagesMax"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[110px]"
					/>
					<ColumnHead label="Backlog size" align="right" width="w-[110px]" hidden="hidden md:flex" />
					<ColumnHead<QueueSortKey>
						label="Consumers"
						sortKey="consumerConcurrency"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[110px]"
					/>
				</>
			}
		>
			{sorted.map((queue) => (
				<div key={queue.serviceName} className={ROW_CLASS}>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] font-medium text-foreground">
						{queue.queueName}
					</div>
					{numCell(formatNumber(Math.round(queue.backlogMessages)))}
					{numCell(formatNumber(Math.round(queue.backlogMessagesMax)))}
					{numCell(formatBytes(queue.backlogBytes), true)}
					{numCell(queue.consumerConcurrency.toFixed(1))}
				</div>
			))}
		</TableShell>
	)
}

type DoSortKey = "scriptName" | "requests" | "errorRate"

function DurableObjectTable({
	durableObjects,
	waiting,
}: {
	durableObjects: ReadonlyArray<CloudflareDurableObjectRow>
	waiting?: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareDurableObjectRow, DoSortKey>(
		durableObjects,
		{ initialKey: "requests", stringKeys: ["scriptName"] },
	)
	return (
		<TableShell
			ariaLabel="Durable Objects"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No Durable Object activity in the selected window."
			header={
				<>
					<ColumnHead<DoSortKey>
						label="Worker"
						sortKey="scriptName"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="flex-1 min-w-[220px]"
					/>
					<ColumnHead<DoSortKey>
						label="DO requests"
						sortKey="requests"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[110px]"
					/>
					<ColumnHead<DoSortKey>
						label="Error rate"
						sortKey="errorRate"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[110px]"
					/>
				</>
			}
		>
			{sorted.map((row) => (
				<div key={row.serviceName} className={ROW_CLASS}>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] font-medium text-foreground">
						{row.scriptName}
					</div>
					{numCell(formatNumber(row.requests))}
					<div
						className={`w-[110px] text-right font-mono text-[12px] tabular-nums ${errorRateClass(row.errorRate)}`}
					>
						{formatPercent(row.errorRate)}
					</div>
				</div>
			))}
		</TableShell>
	)
}

export function CloudflarePlatformSection({
	startTime,
	endTime,
}: {
	startTime: string
	endTime: string
}) {
	const result = useAtomValue(cloudflarePlatformResourcesResultAtom({ data: { startTime, endTime } }))

	return Result.builder(result)
		.onSuccess((data, r) => {
			if (data.queues.length === 0 && data.durableObjects.length === 0) return null
			return (
				<section className="space-y-3">
					<h2 className="text-sm font-medium text-foreground">Platform</h2>
					<div className="space-y-4">
						{data.queues.length > 0 && <QueueTable queues={data.queues} waiting={r.waiting} />}
						{data.durableObjects.length > 0 && (
							<DurableObjectTable durableObjects={data.durableObjects} waiting={r.waiting} />
						)}
					</div>
				</section>
			)
		})
		.orElse(() => null)
}

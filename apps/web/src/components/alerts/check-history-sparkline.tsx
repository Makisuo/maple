import * as React from "react"
import { CartesianGrid, Dot, Legend, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import type { AlertCheckDocument, AlertSignalType } from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@maple/ui/components/ui/chart"
import { SERIES_COLORS } from "./chart-colors"

interface CheckHistorySparklineProps {
	checks: ReadonlyArray<AlertCheckDocument>
	threshold: number
	signalType: AlertSignalType
	className?: string
}

type ChartPoint = { t: number } & Record<string, number | null | undefined>

const SINGLE_SERIES_KEY = "value"
const SINGLE_SERIES_LABEL = "Observed"

export function CheckHistorySparkline({
	checks,
	threshold,
	signalType,
	className,
}: CheckHistorySparklineProps) {
	const { data, seriesKeys, statusLookup, isMultiSeries } = React.useMemo(() => {
		const sorted = checks.toSorted(
			(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		)

		const groupKeys = new Set<string>()
		for (const check of sorted) {
			groupKeys.add(check.groupKey)
		}
		const groupList = Array.from(groupKeys)
		const isMulti = groupList.length > 1
		const seriesKeys = isMulti ? groupList : [SINGLE_SERIES_KEY]

		const byTimestamp = new Map<number, ChartPoint>()
		const statusLookup = new Map<string, AlertCheckDocument["status"]>()

		for (const check of sorted) {
			const t = new Date(check.timestamp).getTime()
			const key = isMulti ? check.groupKey : SINGLE_SERIES_KEY
			const existing = byTimestamp.get(t) ?? { t }
			existing[key] = check.observedValue
			byTimestamp.set(t, existing)
			statusLookup.set(`${t}|${key}`, check.status)
		}

		const data = Array.from(byTimestamp.values())
		for (const point of data) {
			for (const key of seriesKeys) {
				if (!(key in point)) point[key] = null
			}
		}
		data.sort((a, b) => a.t - b.t)

		return { data, seriesKeys, statusLookup, isMultiSeries: isMulti }
	}, [checks])

	const chartConfig: ChartConfig = React.useMemo(() => {
		const config: ChartConfig = {}
		seriesKeys.forEach((key, i) => {
			config[key] = {
				label: isMultiSeries ? key : SINGLE_SERIES_LABEL,
				color: SERIES_COLORS[i % SERIES_COLORS.length]!,
			}
		})
		return config
	}, [seriesKeys, isMultiSeries])

	if (data.length === 0) {
		return null
	}

	return (
		<ChartContainer config={chartConfig} className={className}>
			<LineChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
				<CartesianGrid vertical={false} strokeDasharray="3 3" />
				<XAxis
					dataKey="t"
					tickFormatter={(v: number) =>
						new Date(v).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						})
					}
					fontSize={11}
				/>
				<YAxis
					tickFormatter={(v: number) => formatSignalValue(signalType, v)}
					fontSize={11}
					width={52}
				/>
				<ReferenceLine
					y={threshold}
					stroke="var(--destructive)"
					strokeDasharray="4 4"
					label={{
						value: `threshold ${formatSignalValue(signalType, threshold)}`,
						position: "insideTopRight",
						fontSize: 10,
						fill: "var(--destructive)",
					}}
				/>
				<ChartTooltip
					content={
						<ChartTooltipContent
							labelFormatter={(_, payload) => {
								const raw = payload?.[0]?.payload as ChartPoint | undefined
								return raw ? new Date(raw.t).toLocaleString() : ""
							}}
							formatter={(value, name) => (
								<span className="flex items-center gap-2">
									<span
										className="shrink-0 size-2.5 rounded-[2px]"
										style={{
											backgroundColor:
												chartConfig[name as string]?.color ?? "var(--chart-1)",
										}}
									/>
									<span className="text-muted-foreground">
										{chartConfig[name as string]?.label ?? name}
									</span>
									<span className="font-mono font-medium">
										{typeof value === "number"
											? formatSignalValue(signalType, value)
											: String(value)}
									</span>
								</span>
							)}
						/>
					}
				/>
				{isMultiSeries && (
					<Legend
						verticalAlign="top"
						height={28}
						iconType="circle"
						iconSize={8}
						wrapperStyle={{
							overflowX: "auto",
							overflowY: "hidden",
							whiteSpace: "nowrap",
						}}
						formatter={(value: string) => (
							<span className="text-xs text-muted-foreground">{value}</span>
						)}
					/>
				)}
				{seriesKeys.map((key, i) => {
					const color = SERIES_COLORS[i % SERIES_COLORS.length]!
					return (
						<Line
							key={key}
							type="monotone"
							dataKey={key}
							stroke={color}
							strokeWidth={1.5}
							dot={(props) => {
								const point = props.payload as ChartPoint
								const status = statusLookup.get(`${point.t}|${key}`)
								const isBreached = status === "breached"
								const dotColor = isBreached ? "var(--destructive)" : color
								return (
									<Dot
										{...props}
										r={isBreached ? 3 : 1.5}
										fill={dotColor}
										stroke={dotColor}
									/>
								)
							}}
							isAnimationActive={false}
							connectNulls
						/>
					)
				})}
			</LineChart>
		</ChartContainer>
	)
}

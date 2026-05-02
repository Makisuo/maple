import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
	formatBucketTick,
	formatNumber,
	stubBuckets,
	totalCount,
} from "./live-logs-volume-data";

const SEVERITY_COLORS = {
	INFO: "var(--severity-info)",
	DEBUG: "var(--severity-debug)",
	WARN: "var(--severity-warn)",
	ERROR: "var(--severity-error)",
} as const;

const STACK_ORDER: (keyof typeof SEVERITY_COLORS)[] = ["DEBUG", "INFO", "WARN", "ERROR"];

const HEIGHT = 140;

export default function LiveLogsVolumeChart() {
	const total = totalCount(stubBuckets);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);

	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const update = () => setWidth(el.clientWidth);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return (
		<div className="live-frame">
			<div className="live-frame__head">
				<span>logs · volume · last 5h</span>
				<span className="live-frame__live">
					<span className="live-frame__live-dot" />
					LIVE
				</span>
			</div>
			<div className="px-4 pt-3 pb-4">
				<div className="mb-2 flex items-baseline gap-2">
					<span className="text-fg text-sm font-medium tabular-nums">
						{formatNumber(total)} logs
					</span>
					<span className="text-fg-muted text-xs">in selected range</span>
				</div>
				<div ref={wrapRef} className="w-full select-none" style={{ height: HEIGHT }}>
					{width > 0 && (
						<BarChart
							width={width}
							height={HEIGHT}
							data={stubBuckets}
							margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
						>
							<CartesianGrid
								vertical={false}
								strokeDasharray="3 3"
								stroke="color-mix(in oklab, var(--foreground) 8%, transparent)"
							/>
							<XAxis
								dataKey="bucket"
								tickLine={false}
								axisLine={false}
								tickMargin={6}
								fontSize={10}
								minTickGap={50}
								stroke="var(--muted-foreground)"
								tickFormatter={formatBucketTick}
							/>
							<YAxis
								tickLine={false}
								axisLine={false}
								tickMargin={4}
								fontSize={10}
								width={36}
								stroke="var(--muted-foreground)"
								tickFormatter={(v: number) => formatNumber(v)}
							/>
							{STACK_ORDER.map((key) => (
								<Bar
									key={key}
									dataKey={key}
									stackId="severity"
									fill={SEVERITY_COLORS[key]}
									radius={0}
									isAnimationActive={false}
								/>
							))}
						</BarChart>
					)}
				</div>
			</div>
			<div className="border-border bg-bg-elevated text-fg-muted flex justify-between border-t px-3.5 py-2.5 text-[10px] uppercase tracking-wider">
				<span>4 severities · 60 buckets · 5m each</span>
				<span>warn cluster 11:10–11:40 · error blip 11:50</span>
			</div>
		</div>
	);
}

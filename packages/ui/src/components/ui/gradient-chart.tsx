"use client";

import { useId } from "react";
import { Area, AreaChart } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
} from "./chart";

interface SparklineProps {
  data: { value: number }[];
  color?: string;
  className?: string;
}

export function Sparkline({ data, color = "var(--chart-1)", className }: SparklineProps) {
  const id = useId();
  const gradientId = `sparkline-gradient-${id}`;

  const chartConfig = {
    value: {
      label: "Value",
      color,
    },
  } satisfies ChartConfig;

  if (data.length === 0) {
    return <div className={className} />;
  }

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <Area
          dataKey="value"
          type="monotone"
          fill={`url(#${gradientId})`}
          fillOpacity={0.4}
          stroke="var(--color-value)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

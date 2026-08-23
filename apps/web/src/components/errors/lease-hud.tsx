import * as React from "react"
import type { ActorDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { ActorChip } from "./actor-chip"

interface LeaseHudProps {
	leaseExpiresAt: string
	claimedAt: string | null
	leaseHolder: ActorDocument
	className?: string
}

const DANGER_MS = 60_000
const RING_SIZE = 36
const RING_RADIUS = 14
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function LeaseHud({ leaseExpiresAt, claimedAt, leaseHolder, className }: LeaseHudProps) {
	const [now, setNow] = React.useState(() => Date.now())

	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [])

	const expiresMs = Date.parse(normalizeTimestampInput(leaseExpiresAt))
	const claimedMs = claimedAt ? Date.parse(normalizeTimestampInput(claimedAt)) : null
	if (!Number.isFinite(expiresMs)) return null

	const remainingMs = Math.max(0, expiresMs - now)
	const durationMs =
		claimedMs && Number.isFinite(claimedMs) && expiresMs > claimedMs
			? expiresMs - claimedMs
			: Math.max(remainingMs, 15 * 60_000)
	const progress = durationMs > 0 ? Math.min(1, remainingMs / durationMs) : 0
	const danger = remainingMs > 0 && remainingMs < DANGER_MS
	const expired = remainingMs === 0

	const dashOffset = RING_CIRCUMFERENCE * (1 - progress)

	const ringColor = expired ? "var(--muted-foreground)" : danger ? "var(--destructive)" : "var(--primary)"

	return (
		<div
			className={cn(
				"flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-2.5",
				danger && "border-destructive/40",
				className,
			)}
		>
			<div className="relative shrink-0" style={{ width: RING_SIZE, height: RING_SIZE }}>
				<svg
					width={RING_SIZE}
					height={RING_SIZE}
					viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
					className={cn(danger && "animate-pulse")}
					aria-hidden
				>
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						stroke="var(--border)"
						strokeWidth={3}
						fill="none"
					/>
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						stroke={ringColor}
						strokeWidth={3}
						fill="none"
						strokeLinecap="round"
						strokeDasharray={RING_CIRCUMFERENCE}
						strokeDashoffset={dashOffset}
						transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
						style={{ transition: "stroke-dashoffset 0.5s linear, stroke 0.3s" }}
					/>
				</svg>
			</div>
			{/* Two lines beside the ring, not three things in a row: the rail is
			    ~256px wide, and label + countdown + holder side by side wrapped the
			    label into the holder. */}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-baseline justify-between gap-3">
					<span className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
						<span
							className={cn(
								"inline-block size-1.5 rounded-full",
								expired
									? "bg-muted-foreground"
									: danger
										? "bg-destructive animate-pulse"
										: "bg-primary",
							)}
						/>
						{expired ? "Lease expired" : "Active lease"}
					</span>
					<span
						className={cn(
							"font-mono text-base font-semibold tabular-nums leading-none",
							expired
								? "text-muted-foreground"
								: danger
									? "text-destructive"
									: "text-foreground",
						)}
					>
						{formatCountdown(remainingMs)}
					</span>
				</div>
				<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					<span className="shrink-0">held by</span>
					<ActorChip actor={leaseHolder} className="min-w-0" />
				</div>
			</div>
		</div>
	)
}

function formatCountdown(ms: number): string {
	if (ms <= 0) return "0:00"
	const totalSeconds = Math.ceil(ms / 1000)
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`
}

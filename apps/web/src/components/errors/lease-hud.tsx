import * as React from "react"
import type { ActorDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { ActorChip } from "./actor-chip"

interface LeaseHudProps {
	leaseExpiresAt: string
	claimedAt: string | null
	leaseHolder: ActorDocument
	className?: string
}

const DANGER_MS = 60_000
const RING_SIZE = 40
const RING_RADIUS = 16
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function LeaseHud({ leaseExpiresAt, claimedAt, leaseHolder, className }: LeaseHudProps) {
	const [now, setNow] = React.useState(() => Date.now())

	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [])

	const expiresMs = Date.parse(leaseExpiresAt)
	const claimedMs = claimedAt ? Date.parse(claimedAt) : null
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
				"flex items-center gap-4 rounded-md border border-border/60 bg-card/50 px-4 py-3",
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
			<div className="flex min-w-0 flex-col gap-0.5">
				<div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
				</div>
				<div
					className={cn(
						"font-mono text-xl font-semibold tabular-nums",
						expired ? "text-muted-foreground" : danger ? "text-destructive" : "text-foreground",
					)}
				>
					{formatCountdown(remainingMs)}
				</div>
			</div>
			<div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
				<span>held by</span>
				<ActorChip actor={leaseHolder} />
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

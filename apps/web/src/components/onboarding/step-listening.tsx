import { useState, useEffect, useCallback, useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { motion, AnimatePresence } from "motion/react"
import { useAtomValue, Result } from "@/lib/effect-atom"
import {
  Card,
  CardContent,
} from "@maple/ui/components/ui/card"
import {
  CircleCheckIcon,
  SunIcon,
  HouseIcon,
  PulseIcon,
  FileIcon,
  ClockIcon,
} from "@/components/icons"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { LiveFeedTerminal, type FeedEntry } from "./live-feed-terminal"
import { cn } from "@maple/ui/utils"
import type { ServiceOverview } from "@/api/tinybird/services"

function formatTime() {
  const now = new Date()
  return now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function StepListening({
  isComplete,
  onComplete,
  onSkip,
}: {
  isComplete: boolean
  onComplete: (data: ServiceOverview[]) => void
  onSkip: () => void
}) {
  const [pollCount, setPollCount] = useState(0)
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([
    { time: formatTime(), message: "Polling endpoint..." },
  ])
  const [detectedData, setDetectedData] = useState<ServiceOverview[] | null>(null)
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")

  // Poll every 5 seconds
  useEffect(() => {
    if (isComplete || detectedData) return

    const interval = setInterval(() => {
      setPollCount((c) => c + 1)
      setFeedEntries((prev) => [
        ...prev,
        {
          time: formatTime(),
          message:
            prev.length % 2 === 0
              ? "Polling endpoint..."
              : "No spans detected yet",
        },
      ])
    }, 5000)

    return () => clearInterval(interval)
  }, [isComplete, detectedData])

  const overviewResult = useAtomValue(
    getServiceOverviewResultAtom({
      data: {
        startTime,
        endTime,
      },
      _poll: pollCount,
    } as any),
  )

  // Auto-detect data
  useEffect(() => {
    if (isComplete || detectedData) return

    if (Result.isSuccess(overviewResult) && overviewResult.value.data.length > 0) {
      const data = overviewResult.value.data
      setDetectedData(data)
      setFeedEntries((prev) => [
        ...prev,
        { time: formatTime(), message: `Data detected! ${data.length} service(s) found.` },
      ])
    }
  }, [overviewResult, isComplete, detectedData])

  const stats = useMemo(() => {
    if (!detectedData) return null
    const services = new Set(detectedData.map((d) => d.serviceName)).size
    const totalSpans = detectedData.reduce((sum, d) => sum + d.throughput, 0)
    const avgLatency =
      detectedData.length > 0
        ? detectedData.reduce((sum, d) => sum + d.p50LatencyMs, 0) / detectedData.length
        : 0
    const avgErrorRate =
      detectedData.length > 0
        ? detectedData.reduce((sum, d) => sum + d.errorRate, 0) / detectedData.length
        : 0
    return { services, totalSpans, avgLatency, avgErrorRate }
  }, [detectedData])

  const handleContinue = useCallback(() => {
    onComplete(detectedData ?? [])
  }, [detectedData, onComplete])

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <AnimatePresence mode="wait">
        {detectedData ? (
          <motion.div
            key="detected"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
            className="flex flex-col items-center gap-8 w-full max-w-4xl"
          >
            {/* Success Icon */}
            <div className="flex size-16 items-center justify-center rounded-2xl bg-severity-info/10 text-severity-info">
              <CircleCheckIcon size={36} />
            </div>

            {/* Heading */}
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-semibold tracking-tight">
                You're all set
              </h2>
              <p className="text-muted-foreground text-[15px]">
                Your telemetry is flowing. Here's what we've detected so far.
              </p>
            </div>

            {/* Stats Row */}
            {stats && (
              <div className="flex items-center gap-0 rounded-xl border divide-x">
                <StatItem
                  value={stats.totalSpans.toString()}
                  label="Spans"
                  className="text-severity-info"
                />
                <StatItem
                  value={stats.services.toString()}
                  label="Services"
                  className="text-severity-info"
                />
                <StatItem
                  value={`${Math.round(stats.avgLatency)}ms`}
                  label="Avg Latency"
                />
                <StatItem
                  value={`${(stats.avgErrorRate * 100).toFixed(0)}%`}
                  label="Error Rate"
                />
              </div>
            )}

            {/* Explore Cards */}
            <div className="grid grid-cols-3 gap-4 w-full mt-4">
              {[
                {
                  title: "Overview",
                  description: "Golden signals, error rates, and latency at a glance",
                  href: "/",
                  icon: HouseIcon,
                  cta: "Open dashboard",
                },
                {
                  title: "Traces",
                  description: "Distributed traces across all your services",
                  href: "/traces",
                  icon: PulseIcon,
                  cta: "Explore traces",
                },
                {
                  title: "Logs",
                  description: "Search and filter logs correlated with trace context",
                  href: "/logs",
                  icon: FileIcon,
                  cta: "Search logs",
                },
              ].map((card) => (
                <Link key={card.href} to={card.href} onClick={handleContinue}>
                  <Card className="h-full hover:border-foreground/30 transition-colors">
                    <CardContent className="p-5 space-y-4">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <card.icon size={20} />
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">{card.title}</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {card.description}
                        </p>
                      </div>
                      <p className="text-xs text-primary flex items-center gap-1">
                        {card.cta} <span>&rarr;</span>
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>

            {/* Invite CTA */}
            <p className="text-sm text-muted-foreground pt-4">
              Want to collaborate?{" "}
              <Link to="/settings" className="text-primary hover:underline">
                Invite your team
              </Link>
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="listening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-8 w-full"
          >
            {/* Pulse Rings */}
            <div className="relative flex items-center justify-center size-72">
              {[280, 210, 140].map((size, i) => (
                <motion.div
                  key={size}
                  className="absolute rounded-full border border-primary/10"
                  style={{ width: size, height: size }}
                  animate={{
                    opacity: [0.1, 0.3, 0.1],
                    scale: [1, 1.02, 1],
                  }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    delay: i * 0.5,
                    ease: "easeInOut",
                  }}
                />
              ))}
              <div className="relative z-10 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <SunIcon size={24} />
              </div>
            </div>

            {/* Heading */}
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight">
                Listening for events...
              </h2>
              <p className="text-muted-foreground text-[15px] max-w-md">
                Run your instrumented app and trigger a request. We'll auto-detect
                when traces arrive.
              </p>
            </div>

            {/* Live Feed */}
            <LiveFeedTerminal entries={feedEntries} />

            {/* Footer */}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ClockIcon size={14} />
                Try hitting any endpoint to generate telemetry
              </div>
              <span className="text-border">|</span>
              <button
                type="button"
                onClick={onSkip}
                className="text-primary hover:underline"
              >
                Skip for now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function StatItem({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-8 py-4">
      <span className={cn("text-2xl font-semibold tabular-nums", className)}>
        {value}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
    </div>
  )
}

import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { motion } from "motion/react"
import { toast } from "sonner"
import { Exit } from "effect"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import {
	ArrowLeftIcon,
	ChartBarIcon,
	ChartLineIcon,
	CodeIcon,
	PulseIcon,
	RocketIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { DemoSeedRequest } from "@maple/domain/http"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { cn } from "@maple/ui/utils"

export function StepDemo({
	onComplete,
	onRequestDemo,
	onSkipDemo,
	onBack,
}: {
	onComplete: () => void
	onRequestDemo: () => void
	onSkipDemo: () => void
	onBack?: () => void
}) {
	const navigate = useNavigate()
	const [isSeeding, setIsSeeding] = useState(false)

	const seedMutation = useAtomSet(MapleApiAtomClient.mutation("demo", "seed"), {
		mode: "promiseExit",
	})

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")
	const overviewResult = useAtomValue(
		getServiceOverviewResultAtom({ data: { startTime, endTime } }),
	)
	const services = Result.isSuccess(overviewResult) ? overviewResult.value.data : []
	const realServices = services.filter(
		(s) => !(typeof s.serviceName === "string" && s.serviceName.startsWith("demo-")),
	)
	const hasExistingData = realServices.length > 0

	async function handleSeed() {
		setIsSeeding(true)
		onRequestDemo()
		const result = await seedMutation({ payload: new DemoSeedRequest({ hours: 6 }) })
		setIsSeeding(false)

		if (Exit.isSuccess(result)) {
			toast.success("Demo data loaded — pick a plan to keep exploring")
			onComplete()
			return
		}
		toast.error("Couldn't load demo data — heading on so you can connect your app")
		onComplete()
	}

	function handleSkip() {
		onSkipDemo()
		onComplete()
	}

	function handleViewData() {
		onSkipDemo()
		onComplete()
		navigate({ to: "/" })
	}

	if (hasExistingData) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-auto">
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.3 }}
					className="w-full max-w-md flex flex-col gap-8"
				>
					<div className="text-center space-y-3">
						<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
							You're all set
						</span>
						<h1 className="text-3xl font-semibold tracking-tight">
							We're already seeing your data
						</h1>
						<p className="text-muted-foreground text-[15px] leading-relaxed">
							{realServices.length} service{realServices.length === 1 ? "" : "s"} sending
							telemetry. Jump in to explore.
						</p>
					</div>

					<Card className="border-primary/40 bg-primary/[0.02]">
						<CardContent className="p-6 flex flex-col gap-5">
							<div className="flex items-center gap-3">
								<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
									<ChartBarIcon size={18} />
								</div>
								<div>
									<h3 className="text-sm font-semibold tracking-tight">View your data</h3>
									<p className="text-xs text-muted-foreground">
										Open the dashboard with your real services
									</p>
								</div>
							</div>
							<Button size="lg" onClick={handleViewData} className="gap-2 w-full">
								Take me to my dashboard
								<RocketIcon size={14} />
							</Button>
						</CardContent>
					</Card>
				</motion.div>
			</div>
		)
	}

	return (
		<div className="flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-auto">
			<motion.div
				initial={{ opacity: 0, y: 20 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.3 }}
				className="w-full max-w-3xl flex flex-col gap-10"
			>
				<div className="text-center space-y-3">
					<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
						Try it now
					</span>
					<h1 className="text-3xl font-semibold tracking-tight">
						Want to explore with sample data?
					</h1>
					<p className="text-muted-foreground text-[15px] leading-relaxed max-w-md mx-auto">
						See Maple in action with a realistic demo workspace, or jump in and connect your own
						app first.
					</p>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<DemoOption
						icon={ChartLineIcon}
						title="Explore with demo data"
						recommended
						bullets={[
							"Pre-loaded with 6 hours of synthetic traces, logs, and errors",
							"Four demo services with realistic latency and error patterns",
							"Removable from settings later",
						]}
						actionLabel={isSeeding ? "Generating 1,500 spans…" : "Use demo data"}
						actionIcon={PulseIcon}
						onAction={handleSeed}
						disabled={isSeeding}
						loading={isSeeding}
						primary
					/>
					<DemoOption
						icon={CodeIcon}
						title="I'll connect my app"
						bullets={[
							"Skip ahead and pick a plan",
							"We'll show a setup checklist with your ingest key",
							"Start sending real telemetry whenever you're ready",
						]}
						actionLabel="Skip — connect my app"
						actionIcon={RocketIcon}
						onAction={handleSkip}
						disabled={isSeeding}
					/>
				</div>

				{onBack && !isSeeding && (
					<div className="flex justify-start">
						<Button variant="ghost" onClick={onBack} className="gap-2">
							<ArrowLeftIcon size={14} />
							Back
						</Button>
					</div>
				)}
			</motion.div>
		</div>
	)
}

function DemoOption({
	icon: Icon,
	title,
	bullets,
	actionLabel,
	actionIcon: ActionIcon,
	onAction,
	disabled,
	loading,
	primary,
	recommended,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>
	title: string
	bullets: string[]
	actionLabel: string
	actionIcon: React.ComponentType<{ size?: number; className?: string }>
	onAction: () => void
	disabled?: boolean
	loading?: boolean
	primary?: boolean
	recommended?: boolean
}) {
	return (
		<Card
			className={cn(
				"flex flex-col h-full transition-colors relative overflow-hidden",
				primary ? "border-primary/40 bg-primary/[0.02]" : "",
			)}
		>
			{loading && (
				<div className="absolute inset-x-0 top-0 h-0.5 bg-primary/20 overflow-hidden">
					<div className="h-full w-full bg-primary animate-pulse" />
				</div>
			)}
			<CardContent className="flex-1 flex flex-col gap-5 p-6">
				<div className="flex items-center justify-between">
					<div
						className={cn(
							"flex size-10 items-center justify-center rounded-lg",
							primary ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
						)}
					>
						<Icon size={18} />
					</div>
					{recommended && (
						<span className="text-[10px] font-semibold uppercase tracking-widest text-primary">
							Recommended
						</span>
					)}
				</div>

				<h3 className="text-lg font-semibold tracking-tight">{title}</h3>

				<ul className="space-y-2 flex-1">
					{bullets.map((b) => (
						<li key={b} className="flex gap-2 text-sm text-muted-foreground leading-relaxed">
							<span className="mt-1.5 size-1 rounded-full bg-muted-foreground/60 shrink-0" />
							{b}
						</li>
					))}
				</ul>

				<Button
					size="lg"
					variant={primary ? "default" : "outline"}
					onClick={onAction}
					disabled={disabled}
					className="gap-2 w-full"
				>
					{loading ? <PulseIcon size={14} className="animate-spin" /> : null}
					{actionLabel}
					{!loading && <ActionIcon size={14} />}
				</Button>
			</CardContent>
		</Card>
	)
}

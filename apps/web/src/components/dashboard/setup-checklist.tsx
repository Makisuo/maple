import { useAuth } from "@clerk/clerk-react"
import { useNavigate } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import {
	ChevronDownIcon,
	ChevronUpIcon,
	CircleCheckIcon,
	CodeIcon,
	RocketIcon,
	XmarkIcon,
} from "@/components/icons"
import { GuidedSetup } from "@/components/ingest/guided-setup"
import { SendTestEventStrip } from "@/components/ingest/connection-status"
import { useIngestConnection } from "@/components/ingest/use-ingest-connection"
import { useQuickStart } from "@/hooks/use-quick-start"

export function SetupChecklist() {
	const { orgId } = useAuth()
	const { checklistDismissed } = useQuickStart(orgId)

	// Render nothing — and stop polling — once the checklist is dismissed.
	if (checklistDismissed) return null

	return <SetupChecklistCard />
}

function SetupChecklistCard() {
	const { orgId } = useAuth()
	const { dismissChecklist, checklistExpanded, setChecklistExpanded, demoDataRequested } =
		useQuickStart(orgId)

	const connection = useIngestConnection()

	// initial={false}: no entrance replay when the page loads already connected —
	// the celebration only animates on the actual waiting→connected transition.
	return (
		<AnimatePresence mode="wait" initial={false}>
			{connection.status === "connected" ? (
				<FirstTraceCelebration
					key="celebration"
					serviceName={connection.firstRealService}
					onDismiss={dismissChecklist}
				/>
			) : (
				<ChecklistCard
					key="checklist"
					checklistExpanded={checklistExpanded}
					setChecklistExpanded={setChecklistExpanded}
					demoDataRequested={demoDataRequested}
					dismissChecklist={dismissChecklist}
					connection={connection}
				/>
			)}
		</AnimatePresence>
	)
}

function ChecklistCard({
	checklistExpanded,
	setChecklistExpanded,
	demoDataRequested,
	dismissChecklist,
	connection,
}: {
	checklistExpanded: boolean
	setChecklistExpanded: (expanded: boolean) => void
	demoDataRequested: boolean
	dismissChecklist: () => void
	connection: ReturnType<typeof useIngestConnection>
}) {
	return (
		<motion.div className="shrink-0" exit={{ opacity: 0, transition: { duration: 0.15 } }}>
			<Card className="mb-4 border-primary/30 bg-primary/[0.02] overflow-hidden">
				<div className="flex items-center justify-between gap-4 pr-3">
					<button
						type="button"
						onClick={() => setChecklistExpanded(!checklistExpanded)}
						className="flex flex-1 min-w-0 items-center gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors"
					>
						<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<CodeIcon size={16} />
						</div>
						<div className="min-w-0">
							<p className="text-sm font-medium">
								{demoDataRequested
									? "Demo data is in — now connect your real app"
									: "Connect your app to see real data"}
							</p>
							<p className="text-xs text-muted-foreground">
								{demoDataRequested
									? "You're exploring sample services. Send your own telemetry to see your real stack."
									: "Drop in the snippet and we'll auto-detect your first traces."}
							</p>
						</div>
					</button>
					<div className="flex items-center gap-1 shrink-0">
						<Button
							variant="ghost"
							size="sm"
							aria-label={checklistExpanded ? "Collapse" : "Expand"}
							className="size-8 p-0"
							onClick={() => setChecklistExpanded(!checklistExpanded)}
						>
							{checklistExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							aria-label="Dismiss setup checklist"
							className="size-8 p-0"
							onClick={() => {
								dismissChecklist()
								toast.success("Setup checklist hidden — you can reset it from settings later")
							}}
						>
							<XmarkIcon size={14} />
						</Button>
					</div>
				</div>

				<div
					className="grid transition-[grid-template-rows] duration-200 ease-out"
					style={{ gridTemplateRows: checklistExpanded ? "1fr" : "0fr" }}
				>
					<div className="overflow-hidden">
						<CardContent className="border-t border-primary/20 p-5 space-y-5">
							<GuidedSetup apiKey={connection.apiKey} showCredentials />
							<SendTestEventStrip apiKey={connection.apiKey} onTestSent={connection.refresh} />
						</CardContent>
					</div>
				</div>
			</Card>
		</motion.div>
	)
}

const CELEBRATION_EASE = [0.16, 1, 0.3, 1] as const

function FirstTraceCelebration({ serviceName, onDismiss }: { serviceName?: string; onDismiss: () => void }) {
	const navigate = useNavigate()
	const reducedMotion = useReducedMotion()

	function handleExplore() {
		onDismiss()
		if (serviceName) {
			navigate({ to: "/traces", search: { services: [serviceName] } })
		} else {
			navigate({ to: "/traces" })
		}
	}

	const show = {
		opacity: 1,
		y: 0,
		scale: 1,
		transition: { duration: 0.4, ease: CELEBRATION_EASE },
	}
	// Reduced motion: opacity-only, no rise, no scale, no stagger.
	const item = { hidden: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }, show }
	const iconItem = { hidden: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.5 }, show }

	return (
		<motion.div
			className="shrink-0"
			initial="hidden"
			animate="show"
			variants={{ hidden: {}, show: { transition: { staggerChildren: reducedMotion ? 0 : 0.07 } } }}
		>
			<Card className="mb-4 border-primary/40 bg-primary/[0.04] overflow-hidden">
				<CardContent className="flex items-center gap-4 p-5">
					<motion.div
						variants={iconItem}
						className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
					>
						<CircleCheckIcon size={20} />
					</motion.div>
					<motion.div variants={item} className="flex-1 min-w-0">
						<p className="text-sm font-semibold tracking-tight">
							First trace received — you're live
						</p>
						<p className="text-xs text-muted-foreground mt-0.5">
							{serviceName
								? `We're seeing telemetry from ${serviceName}. Open it to explore.`
								: "We're seeing your telemetry. Jump in to explore."}
						</p>
					</motion.div>
					<motion.div variants={item} className="flex shrink-0 items-center gap-1">
						<Button size="sm" onClick={handleExplore} className="gap-2 shrink-0">
							Explore your traces
							<RocketIcon size={14} />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							aria-label="Dismiss"
							className="size-8 p-0 shrink-0"
							onClick={onDismiss}
						>
							<XmarkIcon size={14} />
						</Button>
					</motion.div>
				</CardContent>
			</Card>
		</motion.div>
	)
}

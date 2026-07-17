import { useAuth } from "@clerk/clerk-react"
import { useNavigate } from "@tanstack/react-router"
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

	if (connection.status === "connected") {
		return (
			<FirstTraceCelebration
				serviceName={connection.firstRealService}
				onDismiss={dismissChecklist}
			/>
		)
	}

	return (
		<Card className="mb-4 shrink-0 border-primary/30 bg-primary/[0.02] overflow-hidden">
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
	)
}

function FirstTraceCelebration({ serviceName, onDismiss }: { serviceName?: string; onDismiss: () => void }) {
	const navigate = useNavigate()

	function handleExplore() {
		onDismiss()
		if (serviceName) {
			navigate({ to: "/traces", search: { services: [serviceName] } })
		} else {
			navigate({ to: "/traces" })
		}
	}

	return (
		<Card className="mb-4 shrink-0 border-primary/40 bg-primary/[0.04] overflow-hidden">
			<CardContent className="flex items-center gap-4 p-5">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<CircleCheckIcon size={20} />
				</div>
				<div className="flex-1 min-w-0">
					<p className="text-sm font-semibold tracking-tight">First trace received — you're live</p>
					<p className="text-xs text-muted-foreground mt-0.5">
						{serviceName
							? `We're seeing telemetry from ${serviceName}. Open it to explore.`
							: "We're seeing your telemetry. Jump in to explore."}
					</p>
				</div>
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
			</CardContent>
		</Card>
	)
}

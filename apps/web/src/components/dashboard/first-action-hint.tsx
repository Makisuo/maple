import { useAuth } from "@clerk/clerk-react"
import { useNavigate } from "@tanstack/react-router"
import { motion, AnimatePresence } from "motion/react"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import { ChartLineIcon, RocketIcon, XmarkIcon } from "@/components/icons"
import { useQuickStart } from "@/hooks/use-quick-start"

export function FirstActionHint() {
	const { orgId } = useAuth()
	const navigate = useNavigate()
	const { demoDataRequested, firstActionHintDismissed, dismissFirstActionHint } = useQuickStart(orgId)

	const visible = demoDataRequested && !firstActionHintDismissed

	function handleShowMe() {
		dismissFirstActionHint()
		navigate({ to: "/traces", search: { services: ["demo-api"] } })
	}

	return (
		<AnimatePresence initial={false}>
			{visible && (
				<motion.div
					initial={{ opacity: 0, y: -8 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -8 }}
					transition={{ duration: 0.2 }}
				>
					<Card className="mb-4 border-primary/40 bg-primary/[0.04] overflow-hidden">
						<CardContent className="flex items-center gap-4 p-4">
							<div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
								<ChartLineIcon size={16} />
							</div>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium">
									Demo data is in. Try opening a slow trace from{" "}
									<code className="text-xs bg-muted px-1 py-0.5 rounded">demo-api</code>.
								</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									We seeded a deliberate latency spike — find it in the traces view.
								</p>
							</div>
							<Button size="sm" onClick={handleShowMe} className="gap-2 shrink-0">
								Show me
								<RocketIcon size={14} />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								aria-label="Dismiss hint"
								className="size-8 p-0 shrink-0"
								onClick={dismissFirstActionHint}
							>
								<XmarkIcon size={14} />
							</Button>
						</CardContent>
					</Card>
				</motion.div>
			)}
		</AnimatePresence>
	)
}

import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "@maple/ui/components/ui/sheet"
import { ExternalLinkIcon } from "@/components/icons"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import {
	encodeAlertContextToSearchParam,
	signalLabel,
	type AlertContext,
} from "@/components/chat/alert-context"
import { alertContextToInvestigation, investigationTabId } from "@/components/chat/investigation-context"

export interface AlertChatSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Null while no incident/context is selected — the sheet renders nothing. */
	alertContext: AlertContext | null
}

/**
 * Right-side slide-over that hosts the full Maple chat seeded with a firing
 * alert's context (mapped onto the unified investigation chat) — so an on-call
 * engineer can keep asking follow-up questions without leaving the alert page.
 *
 * The conversation is addressed by the stable `alert-<incidentId>` tab id, so
 * this panel and the full `/chat?mode=alert` page are the same thread. We mount
 * our own {@link FlueClientProvider} (the chat page mounts one too) so the panel
 * works standalone.
 */
export function AlertChatSheet({ open, onOpenChange, alertContext }: AlertChatSheetProps) {
	const investigation = alertContext ? alertContextToInvestigation(alertContext) : null
	return (
		<Sheet open={open && alertContext !== null} onOpenChange={onOpenChange}>
			{alertContext && investigation ? (
				<SheetPopup
					side="right"
					className="w-[calc(100%-(--spacing(12)))] sm:max-w-2xl"
					closeProps={{ className: "absolute end-3 top-5 z-10" }}
				>
					<SheetHeader className="flex flex-row items-start justify-between gap-3 border-b pe-14 pb-4">
						<div className="min-w-0 space-y-1">
							<SheetTitle className="truncate text-base">{alertContext.ruleName}</SheetTitle>
							<SheetDescription>
								Discuss this {signalLabel(alertContext.signalType)} alert with Maple AI.
							</SheetDescription>
						</div>
						<Button
							size="sm"
							variant="ghost"
							render={
								<Link
									to="/chat"
									search={{
										mode: "alert",
										alert: encodeAlertContextToSearchParam(alertContext),
										tab: investigationTabId(investigation),
									}}
								/>
							}
						>
							Open full page
							<ExternalLinkIcon className="size-3.5" />
						</Button>
					</SheetHeader>
					<div className="flex min-h-0 flex-1 flex-col">
						<FlueClientProvider>
							<ChatConversation
								tabId={investigationTabId(investigation)}
								isActive={open}
								mode="investigation"
								investigationContext={investigation}
							/>
						</FlueClientProvider>
					</div>
				</SheetPopup>
			) : null}
		</Sheet>
	)
}

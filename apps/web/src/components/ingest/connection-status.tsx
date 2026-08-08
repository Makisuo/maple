import { useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { PaperPlaneIcon, PulseIcon } from "@/components/icons"
import { sendTestEvent, type IngestConnection } from "./use-ingest-connection"

/**
 * Compact live-connection indicator for the Connect popover header. Amber pulse
 * while waiting, green dot once telemetry is observed.
 */
export function ConnectionStatusPill({ connection }: { connection: IngestConnection }) {
	const connected = connection.status === "connected"
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
				connected
					? "border-severity-info/30 bg-severity-info/10 text-severity-info"
					: "border-primary/30 bg-primary/10 text-primary",
			)}
		>
			{connected ? (
				<>
					<span className="size-1.5 rounded-full bg-severity-info" />
					Connected · {connection.serviceCount}{" "}
					{connection.serviceCount === 1 ? "service" : "services"}
				</>
			) : (
				<>
					<PulseIcon size={11} className="animate-pulse motion-reduce:animate-none" />
					Waiting for telemetry
				</>
			)}
		</span>
	)
}

/**
 * The waiting strip: "Watching for your first trace…" with a fallback
 * "Send a test event" button. Used by the dashboard checklist (waiting state).
 */
export function SendTestEventStrip({ apiKey, onTestSent }: { apiKey: string; onTestSent: () => void }) {
	const [sending, setSending] = useState(false)

	async function handleSendTest() {
		if (!apiKey || sending) return
		setSending(true)
		try {
			await sendTestEvent(apiKey)
			toastManager.add({ title: "Test event sent — watch for it to land below", type: "success" })
			onTestSent()
		} catch {
			toastManager.add({
				title: "Couldn't reach the ingest endpoint — double-check your API key",
				type: "error",
			})
		} finally {
			setSending(false)
		}
	}

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-center gap-2.5">
				<PulseIcon size={14} className="text-primary animate-pulse motion-reduce:animate-none" />
				<span className="text-xs text-muted-foreground">Watching for your first trace…</span>
			</div>
			<div className="flex items-center gap-2">
				<span className="hidden text-[11px] text-muted-foreground sm:inline">
					Not ready to instrument?
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={handleSendTest}
					disabled={sending || !apiKey}
					className="gap-2 shrink-0"
				>
					<PaperPlaneIcon size={13} />
					{sending ? "Sending…" : "Send a test event"}
				</Button>
			</div>
		</div>
	)
}

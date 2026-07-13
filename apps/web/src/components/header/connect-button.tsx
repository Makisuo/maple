import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	ArrowRightIcon,
	ChatBubbleSparkleIcon,
	CheckIcon,
	ConnectionIcon,
	CopyIcon,
} from "@/components/icons"
import { CopyableField } from "@/components/ingest/copyable-field"
import { ConnectCredentials } from "@/components/ingest/connect-credentials"
import { ConnectionStatusPill } from "@/components/ingest/connection-status"
import { useIngestConnection } from "@/components/ingest/use-ingest-connection"
import { mcpUrl } from "@/lib/services/common/mcp-url"

const ONBOARD_SKILL_COMMAND = "bunx skills add Makisuo/maple/skills/maple-onboard"
const MCP_ENDPOINT = `${mcpUrl}/mcp`

export function ConnectButton() {
	const [open, setOpen] = useState(false)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button variant="default" size="sm" className="gap-2">
						<ConnectionIcon size={14} />
						Connect
					</Button>
				}
			/>
			<PopoverPopup align="end" className="w-[26rem]">
				{open && <ConnectPanel />}
			</PopoverPopup>
		</Popover>
	)
}

function ConnectPanel() {
	const connection = useIngestConnection()

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<div className="flex items-start justify-between gap-2">
					<PopoverTitle className="text-base">Connect your app</PopoverTitle>
					<ConnectionStatusPill connection={connection} />
				</div>
				<PopoverDescription className="text-xs">
					Point your OpenTelemetry SDK at this endpoint to start streaming telemetry into Maple.
				</PopoverDescription>
			</div>

			<ConnectCredentials />

			<Separator />

			<div className="space-y-2">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Fastest path · Claude Code
				</span>
				<CopyableField value={ONBOARD_SKILL_COMMAND} />
				<p className="text-xs text-muted-foreground">
					The <code className="rounded bg-muted px-1">maple-onboard</code> skill installs
					OpenTelemetry and wires traces, logs, and metrics end-to-end.
				</p>
			</div>

			<McpCard />

			<div className="flex items-center justify-between text-xs">
				<Link
					to="/settings"
					search={{ tab: "ingestion" }}
					className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
				>
					Open setup guide
					<ArrowRightIcon size={12} />
				</Link>
				<a
					href="https://maple.dev/docs"
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground underline underline-offset-2 hover:no-underline"
				>
					Documentation
				</a>
			</div>
		</div>
	)
}

function McpCard() {
	const [copied, setCopied] = useState(false)

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(MCP_ENDPOINT)
			setCopied(true)
			toast.success("MCP endpoint copied")
			setTimeout(() => setCopied(false), 1500)
		} catch {
			toast.error("Failed to copy MCP endpoint")
		}
	}

	return (
		<div className="group overflow-hidden rounded-lg border bg-muted/30 transition-colors hover:border-foreground/20">
			<Link
				to="/settings"
				search={{ tab: "mcp" }}
				className="flex items-center gap-3 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-foreground">
					<ChatBubbleSparkleIcon size={15} />
				</span>
				<span className="min-w-0 flex-1 space-y-0.5">
					<span className="flex items-center text-xs font-medium text-foreground">
						Connect your own Agent
					</span>
					<span className="block text-xs text-muted-foreground">
						Claude Code, Cursor, or any MCP client can query your telemetry.
					</span>
				</span>
				<ArrowRightIcon
					size={14}
					className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
				/>
			</Link>
			<div className="flex items-center gap-2 border-t bg-background/60 py-1.5 pl-3 pr-1.5">
				<span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
					MCP
				</span>
				<code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
					{MCP_ENDPOINT}
				</code>
				<Button
					variant="ghost"
					size="icon"
					className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
					onClick={handleCopy}
					aria-label="Copy MCP endpoint"
				>
					{copied ? <CheckIcon size={13} className="text-severity-info" /> : <CopyIcon size={13} />}
				</Button>
			</div>
		</div>
	)
}

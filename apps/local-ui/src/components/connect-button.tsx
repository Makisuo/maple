// Header "Connect" affordance — mirrors the web app's `ConnectButton`
// (popover with the ingest endpoint + quick start), trimmed for local mode:
// no API keys (everything ingests under the synthetic `local` org).

import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import { Separator } from "@maple/ui/components/ui/separator"
import { ConnectionIcon } from "@maple/ui/components/icons"
import { LOCAL_OTLP_ENDPOINT } from "../lib/constants"
import { DOCS_LOCAL_MODE_SEND_TELEMETRY } from "../lib/links"
import { CopyableField } from "./copyable-field"

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
	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<PopoverTitle className="text-base">Connect your app</PopoverTitle>
				<PopoverDescription className="text-xs">
					Point your OpenTelemetry SDK at your local Maple to stream traces, logs and metrics.
				</PopoverDescription>
			</div>

			<CopyableField label="OTLP/HTTP endpoint" value={LOCAL_OTLP_ENDPOINT} />

			<p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
				No API key needed — local mode ingests everything under the{" "}
				<code className="rounded bg-muted px-1">local</code> org.
			</p>

			<Separator />

			<div className="space-y-2">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Quick start
				</span>
				<CopyableField label="" value={`OTEL_EXPORTER_OTLP_ENDPOINT=${LOCAL_OTLP_ENDPOINT}`} />
				<p className="text-xs text-muted-foreground">
					Recording browser sessions? Point{" "}
					<code className="rounded bg-muted px-1">@maple-dev/browser</code> at the same endpoint.
				</p>
			</div>

			<div className="flex items-center justify-end text-xs">
				<a
					href={DOCS_LOCAL_MODE_SEND_TELEMETRY}
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground underline underline-offset-2 hover:no-underline"
				>
					OTLP setup docs
				</a>
			</div>
		</div>
	)
}

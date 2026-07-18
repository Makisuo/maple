import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
import { CheckIcon, CodeIcon, CopyIcon, KeyIcon } from "@/components/icons"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"

/**
 * Keep in sync with `SCOPE_FAMILIES` in create-api-key-dialog.tsx — one row per
 * shipped v2 resource family.
 */
const SCOPE_FAMILY_ROWS = [
	{ id: "api_keys", label: "API keys", description: "Create, roll, and revoke API keys" },
	{ id: "dashboards", label: "Dashboards", description: "Dashboards, templates, and version history" },
	{
		id: "alerts",
		label: "Alerts",
		description: "Alert rules (incl. test/preview/checks), destinations, and incidents",
	},
	{ id: "ingest_keys", label: "Ingest keys", description: "View and roll telemetry ingest keys" },
	{
		id: "attribute_mappings",
		label: "Attribute mappings",
		description: "Ingest-time attribute rewrite rules",
	},
	{
		id: "scrape_targets",
		label: "Scrape targets",
		description: "Prometheus/PlanetScale scrape targets, probes, and checks",
	},
	{ id: "instrumentation", label: "Recommendations", description: "Instrumentation recommendations" },
	{
		id: "investigations",
		label: "Investigations",
		description: "AI investigation war-rooms — list, open, and update status",
	},
	{
		id: "anomalies",
		label: "Anomalies",
		description: "Anomaly incidents (incl. timeseries/resolve/link-issue) and detector settings",
	},
	{
		id: "session_replays",
		label: "Session replays",
		description: "Search sessions, retrieve detail, events, and transcripts",
	},
	{ id: "organization", label: "Organization", description: "Read the organization's identity" },
] as const

const docsUrl = `${apiBaseUrl}/v2/docs`

const curlExample = `curl ${apiBaseUrl}/v2/alerts/rules \\
  -H "Authorization: Bearer maple_ak_..."`

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true)
					toast.success("Copied to clipboard")
					setTimeout(() => setCopied(false), 1500)
				})
			}}
		>
			{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
		</Button>
	)
}

export function DeveloperSection({ onNavigateToApiKeys }: { onNavigateToApiKeys: () => void }) {
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<CardTitle>API Reference</CardTitle>
							<CardDescription>
								The Maple v2 API is a resource-oriented REST interface — snake_case JSON,
								prefixed object IDs, cursor-paginated lists, and scoped API keys.
							</CardDescription>
						</div>
						<Button
							size="sm"
							render={<a href={docsUrl} target="_blank" rel="noopener noreferrer" />}
						>
							<CodeIcon data-icon="inline-start" size={14} />
							Open API reference
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1.5">
						<div className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							Base URL
						</div>
						<div className="bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
							<code className="font-mono text-sm">{apiBaseUrl}/v2</code>
							<CopyButton text={`${apiBaseUrl}/v2`} label="Copy base URL" />
						</div>
					</div>
					<div className="space-y-1.5">
						<div className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							Quick start
						</div>
						<div className="bg-muted/50 flex items-start justify-between gap-2 rounded-md border px-3 py-2">
							<pre className="overflow-x-auto font-mono text-sm leading-6">{curlExample}</pre>
							<CopyButton text={curlExample} label="Copy curl example" />
						</div>
						<p className="text-muted-foreground text-xs">
							Authenticate with a Bearer API key. Create one under{" "}
							<button
								type="button"
								onClick={onNavigateToApiKeys}
								className="text-foreground inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
							>
								<KeyIcon size={12} />
								API Keys
							</button>
							.
						</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Scopes</CardTitle>
					<CardDescription>
						Restricted keys grant <code className="font-mono text-xs">read</code> or{" "}
						<code className="font-mono text-xs">write</code> access per resource family (
						<code className="font-mono text-xs">write</code> implies{" "}
						<code className="font-mono text-xs">read</code>). A key without scopes has full
						access.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="divide-y rounded-md border">
						{SCOPE_FAMILY_ROWS.map((family) => (
							<div
								key={family.id}
								className="flex items-center justify-between gap-4 px-3 py-2.5"
							>
								<div className="min-w-0 space-y-0.5">
									<div className="text-sm font-medium">{family.label}</div>
									<div className="text-muted-foreground truncate text-xs">
										{family.description}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Badge variant="outline" className="font-mono text-[11px]">
										{family.id}:read
									</Badge>
									<Badge variant="outline" className="font-mono text-[11px]">
										{family.id}:write
									</Badge>
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>
		</div>
	)
}

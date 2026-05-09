import { Result, useAtomValue } from "@/lib/effect-atom"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@maple/ui/components/ui/input-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { CheckIcon, ComputerIcon, CopyIcon, NetworkNodesIcon, ServerIcon } from "@/components/icons"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

type Platform = "docker" | "kubernetes" | "linux"

interface InstallModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

function dockerCommand(url: string, token: string) {
	return [
		"docker run -d \\",
		"  --name maple-agent \\",
		"  --pid=host --network=host \\",
		"  -v /proc:/hostfs/proc:ro -v /sys:/hostfs/sys:ro -v /:/hostfs:ro \\",
		`  -e MAPLE_INGEST_URL=${url} \\`,
		`  -e MAPLE_INGEST_TOKEN=${token} \\`,
		"  ghcr.io/maple/collector-agent:latest",
	].join("\n")
}

function helmCommand(url: string, token: string) {
	return [
		"helm repo add maple https://charts.maple.dev",
		"helm repo update",
		"helm install maple-agent maple/collector-agent \\",
		`  --set maple.ingestUrl=${url} \\`,
		`  --set maple.ingestToken=${token}`,
	].join("\n")
}

function linuxCommand(url: string, token: string) {
	return `curl -fsSL https://get.maple.dev/agent.sh | MAPLE_INGEST_URL=${url} MAPLE_INGEST_TOKEN=${token} sh`
}

export function InstallHostModal({ open, onOpenChange }: InstallModalProps) {
	const [platform, setPlatform] = useState<Platform>("docker")
	const [copied, setCopied] = useState(false)

	const keysResult = useAtomValue(MapleApiAtomClient.query("ingestKeys", "get", {}))

	const token = useMemo(
		() =>
			Result.builder(keysResult)
				.onSuccess((v) => v.privateKey)
				.orElse(() => ""),
		[keysResult],
	)

	const snippet = useMemo(() => {
		if (!token) return ""
		switch (platform) {
			case "docker":
				return dockerCommand(ingestUrl, token)
			case "kubernetes":
				return helmCommand(ingestUrl, token)
			case "linux":
				return linuxCommand(ingestUrl, token)
		}
	}, [platform, token])

	async function handleCopy() {
		if (!snippet) return
		try {
			await navigator.clipboard.writeText(snippet)
			setCopied(true)
			toast.success("Install command copied")
			setTimeout(() => setCopied(false), 2000)
		} catch {
			toast.error("Failed to copy")
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl overflow-hidden">
				<DialogHeader>
					<DialogTitle>Install the infrastructure agent</DialogTitle>
					<DialogDescription>
						Maple ships host, container, and Kubernetes metrics through the OpenTelemetry
						collector. Pick a platform and run the command below on your target host. The new
						host will appear here within about a minute.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2 min-w-0">
					<Tabs value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
						<TabsList>
							<TabsTrigger value="docker" className="gap-1.5">
								<ServerIcon size={13} />
								Docker
							</TabsTrigger>
							<TabsTrigger value="kubernetes" className="gap-1.5">
								<NetworkNodesIcon size={13} />
								Kubernetes
							</TabsTrigger>
							<TabsTrigger value="linux" className="gap-1.5">
								<ComputerIcon size={13} />
								Linux
							</TabsTrigger>
						</TabsList>

						<TabsContent value="docker" className="pt-4">
							<p className="text-muted-foreground mb-3 text-xs">
								Runs the contrib collector with hostmetrics, docker stats, and OTLP receivers.
								Requires Docker &ge; 20.10.
							</p>
						</TabsContent>
						<TabsContent value="kubernetes" className="pt-4">
							<p className="text-muted-foreground mb-3 text-xs">
								Deploys a DaemonSet for per-node hostmetrics + kubeletstats, plus a
								single-replica deployment for cluster-wide signals.
							</p>
						</TabsContent>
						<TabsContent value="linux" className="pt-4">
							<p className="text-muted-foreground mb-3 text-xs">
								Installs the collector binary and a systemd unit. Requires sudo.
							</p>
						</TabsContent>
					</Tabs>

					{Result.isInitial(keysResult) ? (
						<Skeleton className="h-36 w-full" />
					) : (
						<InputGroup>
							<InputGroupTextarea
								readOnly
								value={snippet}
								rows={platform === "linux" ? 2 : 7}
								className="font-mono text-xs tracking-wide select-all whitespace-pre leading-relaxed"
							/>
							<InputGroupAddon align="block-end">
								<InputGroupButton
									onClick={handleCopy}
									aria-label="Copy command"
									title={copied ? "Copied!" : "Copy"}
									className="ml-auto"
								>
									{copied ? (
										<>
											<CheckIcon size={14} className="text-severity-info" />
											Copied
										</>
									) : (
										<>
											<CopyIcon size={14} />
											Copy
										</>
									)}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					)}

					<p className="text-muted-foreground text-xs">
						The token above is your org's{" "}
						<strong className="text-foreground">private ingest key</strong>. Rotate it from
						Settings → Ingestion if it leaks.
					</p>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button
						variant="outline"
						render={
							<a
								href="https://maple.dev/docs/infrastructure"
								target="_blank"
								rel="noopener noreferrer"
							/>
						}
					>
						View docs
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

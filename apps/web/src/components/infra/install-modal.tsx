import { Result, useAtomValue } from "@/lib/effect-atom"
import { useMemo, useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@maple/ui/components/ui/input-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { CheckIcon, CopyIcon, EyeIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const HOSTED_INGEST_URL = "https://ingest.maple.dev"
const DOCS_URL = "https://maple.dev/docs/guides/kubernetes-infrastructure"

interface InstallModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

// Mask the secret so it isn't sitting in plaintext (screenshots, shoulder
// surfing). Keep the `maple_sk_` prefix for recognizability and use a
// fixed-width dot run so the real key length isn't leaked.
function maskToken(token: string) {
	const prefix = "maple_sk_"
	return token.startsWith(prefix) ? `${prefix}${"•".repeat(24)}` : "•".repeat(24)
}

function helmCommand(token: string) {
	const lines = [
		"helm upgrade --install maple-k8s-infra \\",
		"  oci://ghcr.io/makisuo/charts/maple-k8s-infra \\",
		"  --namespace maple --create-namespace \\",
		`  --set-string maple.ingestKey.value=${token} \\`,
		"  --set-string global.clusterName=production",
	]
	// Self-hosted Maple: tell the collector where to send OTLP. Hosted installs
	// use the chart's baked-in default, so we omit the flag to keep it clean.
	if (ingestUrl !== HOSTED_INGEST_URL) {
		lines[lines.length - 1] += " \\"
		lines.push(`  --set-string maple.ingest.endpoint=${ingestUrl}`)
	}
	return lines.join("\n")
}

export function InstallHostModal({ open, onOpenChange }: InstallModalProps) {
	const { copied, copy } = useCopyToClipboard("Install command")
	const [revealed, setRevealed] = useState(false)

	const keysResult = useAtomValue(MapleApiAtomClient.query("ingestKeys", "get", {}))

	const token = useMemo(
		() =>
			Result.builder(keysResult)
				.onSuccess((v) => v.privateKey)
				.orElse(() => ""),
		[keysResult],
	)

	// `snippet` is the real command (used for copy); `displaySnippet` masks the
	// key unless the user explicitly reveals it.
	const snippet = useMemo(() => (token ? helmCommand(token) : ""), [token])
	const displaySnippet = useMemo(
		() => (revealed || !token ? snippet : helmCommand(maskToken(token))),
		[revealed, snippet, token],
	)

	function handleCopy() {
		if (!snippet) return
		copy(snippet)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Re-mask the key whenever the modal closes, so it's never exposed
				// by default on the next open.
				if (!next) setRevealed(false)
				onOpenChange(next)
			}}
		>
			<DialogContent className="max-w-2xl overflow-hidden">
				<DialogHeader>
					<DialogTitle>Install the Kubernetes collector</DialogTitle>
					<DialogDescription>
						The Maple Helm chart deploys a DaemonSet for per-node host + kubelet metrics and a
						single-replica deployment for cluster-wide signals. Run the command below against your
						cluster — nodes and pods appear here within about a minute.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 min-w-0">
					{Result.isInitial(keysResult) ? (
						<Skeleton className="h-36 w-full" />
					) : (
						<InputGroup>
							<InputGroupTextarea
								readOnly
								wrap="off"
								value={displaySnippet}
								rows={ingestUrl !== HOSTED_INGEST_URL ? 6 : 5}
								className="font-mono text-xs tracking-wide select-all leading-relaxed"
							/>
							<InputGroupAddon align="block-end">
								<InputGroupButton
									onClick={() => setRevealed((v) => !v)}
									aria-label={revealed ? "Hide key" : "Reveal key"}
									title={revealed ? "Hide key" : "Reveal key"}
								>
									<EyeIcon size={14} />
									{revealed ? "Hide key" : "Reveal key"}
								</InputGroupButton>
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
						The command embeds your org's{" "}
						<strong className="text-foreground">private ingest key</strong>. Rotate it from
						Settings → Ingestion if it leaks. For production, prefer an existing Secret over an
						inline value — see the docs.
					</p>
				</DialogPanel>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button
						variant="outline"
						render={
							<a
								href={DOCS_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="View docs"
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

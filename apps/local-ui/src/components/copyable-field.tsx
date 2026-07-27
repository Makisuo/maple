// A read-only input with a copy-to-clipboard button. Shared by the header
// `ConnectButton` popover and the `DisconnectedState` screen so the "here's the
// endpoint / command" affordance reads the same wherever it appears.

import { useState } from "react"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { CheckIcon, CopyIcon } from "@maple/ui/components/icons"

export function CopyableField({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false)

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard can be unavailable on insecure origins — fail silently.
		}
	}

	return (
		<div className="space-y-1">
			{label && <label className="text-xs text-muted-foreground">{label}</label>}
			<InputGroup>
				<InputGroupInput
					readOnly
					value={value}
					className="select-all font-mono text-xs tracking-wide"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						onClick={handleCopy}
						aria-label={`Copy ${(label || "command").toLowerCase()}`}
					>
						{copied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</div>
	)
}

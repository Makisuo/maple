import { useState } from "react"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { CheckIcon, CopyIcon, EyeIcon } from "@/components/icons"
import { maskKey } from "@/components/ingest/copyable-field"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

interface ApiKeySecretRevealProps {
	secret: string
}

/**
 * Read-only reveal of a freshly minted API key secret, shown once at create/roll
 * time. Masked by default behind an eye toggle (same idiom as the ingest key
 * fields); copy always copies the full secret. Shared by the create and roll
 * dialogs so the "copy it now, you won't see it again" UX stays identical.
 */
export function ApiKeySecretReveal({ secret }: ApiKeySecretRevealProps) {
	const { copied, copy } = useCopyToClipboard("API key")
	const [isVisible, setIsVisible] = useState(false)

	return (
		<div className="space-y-3">
			<InputGroup>
				<InputGroupInput
					readOnly
					value={isVisible ? secret : maskKey(secret)}
					className={
						isVisible
							? "font-mono text-xs tracking-wide select-all"
							: "font-mono text-xs tracking-wide"
					}
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						onClick={() => setIsVisible((v) => !v)}
						aria-label={isVisible ? "Hide key" : "Reveal key"}
					>
						<EyeIcon size={14} className={isVisible ? "text-foreground" : undefined} />
					</InputGroupButton>
					<InputGroupButton
						onClick={() => copy(secret)}
						aria-label="Copy API key"
						title={copied ? "Copied!" : "Copy"}
					>
						{copied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			<p className="text-muted-foreground text-xs">
				Store this key in a secure location. It will not be shown again.
			</p>
		</div>
	)
}

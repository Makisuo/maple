import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { CheckIcon, CopyIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

interface ApiKeySecretRevealProps {
	secret: string
}

/**
 * Read-only reveal of a freshly minted API key secret, shown once at create/roll
 * time. Shared by the create and roll dialogs so the "copy it now, you won't see
 * it again" UX stays identical.
 */
export function ApiKeySecretReveal({ secret }: ApiKeySecretRevealProps) {
	const { copied, copy } = useCopyToClipboard("API key")

	return (
		<div className="space-y-3">
			<InputGroup>
				<InputGroupInput
					readOnly
					value={secret}
					className="font-mono text-xs tracking-wide select-all"
				/>
				<InputGroupAddon align="inline-end">
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

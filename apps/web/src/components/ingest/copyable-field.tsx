import { useState } from "react"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { CheckIcon, CopyIcon, EyeIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

/** Mask an ingest key, keeping the readable prefix + last four characters. */
export function maskKey(key: string): string {
	if (key.length <= 18) return key
	const prefix = key.slice(0, 14)
	const suffix = key.slice(-4)
	return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

interface CopyableFieldProps {
	value: string
	/** Optional caption rendered above the field. */
	label?: string
	/** Mask the value behind a reveal toggle (for secrets). */
	masked?: boolean
}

/**
 * Read-only value with copy (and optional reveal) affordances. The single
 * implementation shared by the Connect popover, ingestion settings, and the
 * dashboard setup checklist.
 */
export function CopyableField({ value, label, masked }: CopyableFieldProps) {
	const { copied, copy } = useCopyToClipboard(label || "Command")
	const [isVisible, setIsVisible] = useState(false)

	return (
		<div className="space-y-1">
			{label && <label className="text-xs text-muted-foreground">{label}</label>}
			<InputGroup>
				<InputGroupInput
					readOnly
					value={masked && !isVisible ? maskKey(value) : value}
					className="font-mono text-xs tracking-wide select-all"
				/>
				<InputGroupAddon align="inline-end">
					{masked && (
						<InputGroupButton
							onClick={() => setIsVisible((v) => !v)}
							aria-label={isVisible ? "Hide key" : "Reveal key"}
						>
							<EyeIcon size={14} className={isVisible ? "text-foreground" : undefined} />
						</InputGroupButton>
					)}
					<InputGroupButton
						onClick={() => copy(value)}
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

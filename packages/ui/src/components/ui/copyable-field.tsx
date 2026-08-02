"use client"

import * as React from "react"

import { EyeIcon } from "../icons"
import { CopyButton } from "./copy-button"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "./input-group"

/** Mask a secret, keeping the readable prefix + last four characters. */
export function maskKey(key: string): string {
	if (key.length <= 18) return key
	const prefix = key.slice(0, 14)
	const suffix = key.slice(-4)
	return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

export interface CopyableFieldProps {
	value: string
	/** Optional caption rendered above the field. Also names the value in the
	 * copy toast unless `copyLabel` overrides it. */
	label?: string
	/** Name for the copied thing when the field carries no caption (or when the
	 * caption doesn't read as a noun in "<name> copied"). */
	copyLabel?: string
	/** Mask the value behind a reveal toggle (for secrets). */
	masked?: boolean
}

/**
 * Read-only value with copy (and optional reveal) affordances. The single
 * implementation shared by the Connect popover, ingestion settings, the
 * dashboard setup checklist, and the local UI's disconnected state.
 */
export function CopyableField({
	value,
	label,
	copyLabel,
	masked,
}: CopyableFieldProps): React.ReactElement {
	const [isVisible, setIsVisible] = React.useState(false)

	return (
		<div className="space-y-1">
			{label && <label className="text-xs text-muted-foreground">{label}</label>}
			<InputGroup>
				<InputGroupInput
					readOnly
					value={masked && !isVisible ? maskKey(value) : value}
					className="select-all font-mono text-xs tracking-wide"
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
					<CopyButton
						value={value}
						label={copyLabel || label || "Value"}
						render={<InputGroupButton />}
					/>
				</InputGroupAddon>
			</InputGroup>
		</div>
	)
}

// Controlled magnifier + clear-button search input for filtering already-loaded
// content (attribute tables, in-panel lists). Deliberately not debounced —
// `ToolbarSearch` in ../toolbar.tsx is the debounced sibling for inputs whose
// value fans out into queries.

import { MagnifierIcon, XmarkIcon } from "../icons"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group"

export interface SearchInputProps {
	value: string
	onValueChange: (value: string) => void
	placeholder?: string
	className?: string
}

export function SearchInput({ value, onValueChange, placeholder, className }: SearchInputProps) {
	return (
		<InputGroup className={className}>
			<InputGroupAddon>
				<MagnifierIcon />
			</InputGroupAddon>
			<InputGroupInput
				size="sm"
				type="text"
				value={value}
				onChange={(e) => onValueChange(e.target.value)}
				placeholder={placeholder}
			/>
			{value && (
				<InputGroupAddon align="inline-end">
					<InputGroupButton aria-label="Clear search" onClick={() => onValueChange("")}>
						<XmarkIcon />
					</InputGroupButton>
				</InputGroupAddon>
			)}
		</InputGroup>
	)
}

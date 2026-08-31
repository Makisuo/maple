import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Kbd } from "@maple/ui/components/ui/kbd"

import { LogSearchHelp } from "./log-search-help"

interface LogSearchInputProps {
	value: string
	onChange: (value: string) => void
}

/**
 * The logs search box. One field for two lookups (see `parseLogSearch`) — the
 * help sheet beside the label is where the shapes it accepts are listed, since
 * the placeholder has room for one of them at this width.
 */
export function LogSearchInput({ value, onChange }: LogSearchInputProps) {
	return (
		<div className="pb-3">
			<div className="flex items-center gap-1">
				<span className={`${FILTER_SECTION_LABEL} text-muted-foreground`}>Search</span>
				<LogSearchHelp />
			</div>
			<InputGroup className="mt-2">
				<InputGroupAddon>
					<MagnifierIcon />
				</InputGroupAddon>
				<InputGroupInput
					size="sm"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder="Text or trace id"
					data-shortcut-focus="search"
				/>
				{!value && (
					<InputGroupAddon align="inline-end">
						<Kbd>/</Kbd>
					</InputGroupAddon>
				)}
				{value && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton aria-label="Clear search" onClick={() => onChange("")}>
							<XmarkIcon />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</div>
	)
}

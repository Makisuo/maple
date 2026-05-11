import type { SpanNode } from "@/api/tinybird/traces"
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import {
	colorByFieldId,
	colorByFromId,
	colorByLabel,
	type ColorByField,
} from "./color-by"
import { useTraceAttributeKeys } from "./use-trace-attribute-keys"

interface ColorByPickerProps {
	value: ColorByField
	onChange: (next: ColorByField) => void
	rootSpans: SpanNode[]
}

const PRESETS: ColorByField[] = [
	{ kind: "preset", key: "service" },
	{ kind: "preset", key: "spanKind" },
	{ kind: "preset", key: "statusCode" },
]

export function ColorByPicker({ value, onChange, rootSpans }: ColorByPickerProps) {
	const attributeKeys = useTraceAttributeKeys(rootSpans)
	const spanAttrs = attributeKeys.filter((a) => a.kind === "spanAttribute")
	const resourceAttrs = attributeKeys.filter((a) => a.kind === "resourceAttribute")

	return (
		<Select
			value={colorByFieldId(value)}
			onValueChange={(id) => {
				if (typeof id !== "string") return
				const next = colorByFromId(id)
				if (next) onChange(next)
			}}
		>
			<SelectTrigger size="sm" className="h-5 text-[10px] gap-1 px-2 py-0 rounded-md">
				<span className="text-muted-foreground">Color:</span>
				<SelectValue placeholder="Service">{colorByLabel(value)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel>Presets</SelectLabel>
					{PRESETS.map((preset) => (
						<SelectItem key={colorByFieldId(preset)} value={colorByFieldId(preset)}>
							{colorByLabel(preset)}
						</SelectItem>
					))}
				</SelectGroup>
				{spanAttrs.length > 0 && (
					<>
						<SelectSeparator />
						<SelectGroup>
							<SelectLabel>Span attributes</SelectLabel>
							{spanAttrs.map((a) => {
								const field: ColorByField = { kind: "spanAttribute", key: a.key }
								return (
									<SelectItem
										key={colorByFieldId(field)}
										value={colorByFieldId(field)}
										title={`${a.count} span${a.count === 1 ? "" : "s"}`}
									>
										<span className="font-mono">{a.key}</span>
									</SelectItem>
								)
							})}
						</SelectGroup>
					</>
				)}
				{resourceAttrs.length > 0 && (
					<>
						<SelectSeparator />
						<SelectGroup>
							<SelectLabel>Resource attributes</SelectLabel>
							{resourceAttrs.map((a) => {
								const field: ColorByField = { kind: "resourceAttribute", key: a.key }
								return (
									<SelectItem
										key={colorByFieldId(field)}
										value={colorByFieldId(field)}
										title={`${a.count} span${a.count === 1 ? "" : "s"}`}
									>
										<span className="text-muted-foreground mr-1">R:</span>
										<span className="font-mono">{a.key}</span>
									</SelectItem>
								)
							})}
						</SelectGroup>
					</>
				)}
			</SelectContent>
		</Select>
	)
}

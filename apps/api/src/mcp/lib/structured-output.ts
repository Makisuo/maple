import type { StructuredToolOutput } from "@maple/domain"

export const STRUCTURED_MARKER = "__maple_ui"

export function createDualContent(text: string, data: StructuredToolOutput) {
	return [
		{ type: "text" as const, text },
		{
			type: "text" as const,
			text: JSON.stringify({ [STRUCTURED_MARKER]: true, ...data }),
		},
	]
}

import type { StructuredToolOutput } from "@maple/domain"
import { Renderer, JSONUIProvider } from "@json-render/react"
import { registry } from "./registry"
import { buildSpec } from "./build-spec"

export function ToolRenderer({ data }: { data: StructuredToolOutput }) {
	const spec = buildSpec(data)
	return (
		<JSONUIProvider registry={registry}>
			<Renderer spec={spec} registry={registry} />
		</JSONUIProvider>
	)
}

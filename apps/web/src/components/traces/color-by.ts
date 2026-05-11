import type { SpanNode } from "@/api/tinybird/traces"

export type ColorByField =
	| { kind: "preset"; key: "service" | "spanKind" | "statusCode" }
	| { kind: "spanAttribute"; key: string }
	| { kind: "resourceAttribute"; key: string }

export const DEFAULT_COLOR_BY: ColorByField = { kind: "preset", key: "service" }

export function resolveColorValue(
	span: Pick<SpanNode, "serviceName" | "spanKind" | "statusCode" | "spanAttributes" | "resourceAttributes">,
	colorBy: ColorByField,
): string | undefined {
	switch (colorBy.kind) {
		case "preset":
			if (colorBy.key === "service") return span.serviceName
			if (colorBy.key === "spanKind") return span.spanKind
			return span.statusCode
		case "spanAttribute":
			return span.spanAttributes?.[colorBy.key]
		case "resourceAttribute":
			return span.resourceAttributes?.[colorBy.key]
	}
}

export function colorByFieldId(colorBy: ColorByField): string {
	switch (colorBy.kind) {
		case "preset":
			return `preset:${colorBy.key}`
		case "spanAttribute":
			return `span:${colorBy.key}`
		case "resourceAttribute":
			return `resource:${colorBy.key}`
	}
}

export function colorByFromId(id: string): ColorByField | null {
	const [kind, ...rest] = id.split(":")
	const key = rest.join(":")
	if (!key) return null
	if (kind === "preset" && (key === "service" || key === "spanKind" || key === "statusCode")) {
		return { kind: "preset", key }
	}
	if (kind === "span") return { kind: "spanAttribute", key }
	if (kind === "resource") return { kind: "resourceAttribute", key }
	return null
}

export function colorByLabel(colorBy: ColorByField): string {
	switch (colorBy.kind) {
		case "preset":
			if (colorBy.key === "service") return "Service"
			if (colorBy.key === "spanKind") return "Span kind"
			return "Status code"
		case "spanAttribute":
			return colorBy.key
		case "resourceAttribute":
			return colorBy.key
	}
}

export function isStatusCodePreset(colorBy: ColorByField): boolean {
	return colorBy.kind === "preset" && colorBy.key === "statusCode"
}

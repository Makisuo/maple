// JS-side mirror of the semantic color tokens defined in `global.css`.
// Tailwind classes (bg-primary, text-destructive, etc.) pull from oklch CSS variables,
// but inline `style={{ color: ... }}` props can't read those variables at runtime,
// so every JS-side color must come from this file.

export const colors = {
	primary: "#d4873b",
	primaryForeground: "#1a1714",
	error: "#c45a3c",
	success: "#5cb88a",
	warning: "#d4a843",
	mutedForeground: "#8a7f72",
	foreground: "#e8e0d6",
} as const

export const severityColors: Record<string, string> = {
	TRACE: "#8a8078",
	DEBUG: "#6b9ff0",
	INFO: "#5cb88a",
	WARN: "#c89b48",
	ERROR: "#c45a3c",
	FATAL: "#a03a20",
}

export {
	HTTP_METHOD_COLORS,
	getServiceColor,
	getStatusColor,
	getStatusBgColor,
} from "./colors"

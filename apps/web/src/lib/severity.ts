export const SEVERITY_COLORS: Record<string, string> = {
	TRACE: "var(--color-severity-trace)",
	DEBUG: "var(--color-severity-debug)",
	INFO: "var(--color-severity-info)",
	WARN: "var(--color-severity-warn)",
	WARNING: "var(--color-severity-warn)",
	ERROR: "var(--color-severity-error)",
	FATAL: "var(--color-severity-fatal)",
}

export const SEVERITY_ORDER = ["FATAL", "ERROR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE"]

export function getSeverityColor(severity: string): string {
	return SEVERITY_COLORS[severity.toUpperCase()] ?? "var(--color-muted-foreground)"
}

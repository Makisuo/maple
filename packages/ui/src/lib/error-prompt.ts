// Builds an LLM-ready debugging prompt from an error message plus the handful of
// telemetry attributes that usually matter. Shared by the log error banner and
// the span detail panel's "Copy as prompt" action.

export interface ErrorPromptInput {
	message: string
	serviceName: string
	/** Span name / operation. Omitted for logs that aren't tied to an operation. */
	operation?: string
	attributes?: Record<string, string>
}

const RELEVANT_KEYS = [
	"http.method",
	"http.url",
	"http.route",
	"http.status_code",
	"db.system.name",
	"db.system",
	"db.query.text",
	"db.statement",
	"rpc.method",
	"rpc.service",
	"messaging.system",
	"messaging.operation",
]

export function formatErrorPrompt({ message, serviceName, operation, attributes }: ErrorPromptInput): string {
	const contextLines: string[] = []
	if (attributes) {
		for (const key of RELEVANT_KEYS) {
			if (attributes[key]) contextLines.push(`- ${key}: ${attributes[key]}`)
		}
	}

	return `I'm debugging an error in my distributed system. Please help me understand and fix this issue.

**Service:** ${serviceName}${operation ? `\n**Operation:** ${operation}` : ""}

**Error:**
\`\`\`
${message}
\`\`\`
${
	contextLines.length > 0
		? `
**Context:**
${contextLines.join("\n")}
`
		: ""
}
What could be causing this error and how can I fix it?`
}

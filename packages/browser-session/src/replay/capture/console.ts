import { type Emit, safeEmit } from "./shared"

const LEVELS = ["log", "info", "warn", "error", "debug"] as const
type Level = (typeof LEVELS)[number]

const MAX_MESSAGE = 2_000

/**
 * Capture `console.*` calls as session events. Wraps each method, emits a
 * distilled record, then forwards to the original so the host app's console
 * behaves normally. Never throws into the call site.
 */
export function installConsoleCapture(emit: Emit): () => void {
	const original: Partial<Record<Level, (...args: unknown[]) => void>> = {}

	for (const level of LEVELS) {
		const orig = console[level] as (...args: unknown[]) => void
		original[level] = orig
		console[level] = (...args: unknown[]) => {
			// Capture must never break the host app's logging.
			safeEmit(emit, { type: "console", level, message: formatArgs(args) })
			orig.apply(console, args)
		}
	}

	return () => {
		for (const level of LEVELS) {
			const orig = original[level]
			if (orig) console[level] = orig as never
		}
	}
}

function formatArgs(args: unknown[]): string {
	const text = args
		.map((a) => {
			if (typeof a === "string") return a
			if (a instanceof Error) return `${a.name}: ${a.message}`
			try {
				return JSON.stringify(a)
			} catch {
				return String(a)
			}
		})
		.join(" ")
	return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
}

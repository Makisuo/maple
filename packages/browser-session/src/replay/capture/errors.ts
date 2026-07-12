import { activeTraceId } from "../events"
import { type Emit, safeEmit } from "./shared"

const MAX_STACK = 4_000

/** Capture uncaught errors + unhandled promise rejections as session events. */
export function installErrorCapture(emit: Emit): () => void {
	const onError = (event: ErrorEvent): void => {
		safeEmit(emit, {
			type: "error",
			level: "error",
			message: event.message || String(event.error ?? "Error"),
			errorStack: truncate(event.error?.stack),
			traceId: activeTraceId(),
		})
	}

	const onRejection = (event: PromiseRejectionEvent): void => {
		const reason = event.reason as { message?: string; stack?: string } | string | undefined
		const message =
			typeof reason === "string" ? reason : (reason?.message ?? "Unhandled promise rejection")
		safeEmit(emit, {
			type: "error",
			level: "error",
			message,
			errorStack: truncate(typeof reason === "object" ? reason?.stack : undefined),
			traceId: activeTraceId(),
		})
	}

	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onRejection)

	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onRejection)
	}
}

function truncate(stack: string | undefined): string | undefined {
	if (!stack) return undefined
	return stack.length > MAX_STACK ? `${stack.slice(0, MAX_STACK)}…` : stack
}

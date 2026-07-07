import type { SessionEvent } from "../events"

/** The sink every capture module pushes distilled events into. */
export type Emit = (ev: SessionEvent) => void

/** Emit best-effort: capture must never throw into the host app's call site. */
export function safeEmit(emit: Emit, ev: SessionEvent): void {
	try {
		emit(ev)
	} catch {
		// best-effort
	}
}

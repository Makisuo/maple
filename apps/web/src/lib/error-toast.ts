import { toastManager } from "@maple/ui/components/ui/toast"
import { formatBackendError } from "./error-messages"

interface ShowErrorToastOptions {
	/** Operation-specific headline, such as "State change failed". */
	readonly title?: string
	/** Used only when the failure is not one of Maple's recognized error shapes. */
	readonly fallbackTitle?: string
	readonly type?: "error" | "warning"
}

/**
 * Put every mutation failure through the same safe formatter before it reaches
 * a toast. Raw Cause/Exit/error messages belong in telemetry, not UI copy.
 */
export const showErrorToast = (error: unknown, options: ShowErrorToastOptions = {}): void => {
	const presentation = formatBackendError(error)
	toastManager.add({
		title:
			options.title ??
			(presentation.recognized ? presentation.title : (options.fallbackTitle ?? presentation.title)),
		description: presentation.description,
		type: options.type ?? "error",
	})
}

/** Safe one-line compatibility helper for surfaces that can only render a title. */
export const errorMessage = (error: unknown, fallback: string): string => {
	const presentation = formatBackendError(error)
	return presentation.recognized ? presentation.description : fallback
}

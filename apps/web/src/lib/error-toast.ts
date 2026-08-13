import { toastManager } from "@maple/ui/components/ui/toast"
import { displayError, isUnexpectedError } from "./error-messages"

interface ShowErrorToastOptions {
	readonly title?: string
	readonly fallbackTitle?: string
	readonly type?: "error" | "warning"
}

/** Keeps raw Cause/Exit/error messages in telemetry rather than UI copy. */
export const showErrorToast = (error: unknown, options: ShowErrorToastOptions = {}): void => {
	const presentation = displayError(error)
	toastManager.add({
		title:
			options.title ??
			(isUnexpectedError(presentation)
				? (options.fallbackTitle ?? presentation.title)
				: presentation.title),
		description: presentation.message,
		type: options.type ?? "error",
	})
}

export const errorMessage = (error: unknown, fallback: string): string => {
	const presentation = displayError(error)
	return isUnexpectedError(presentation) ? fallback : presentation.message
}

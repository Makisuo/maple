import { toastManager } from "@maple/ui/components/ui/toast"
import { formatBackendError } from "./error-messages"

interface ShowErrorToastOptions {
	readonly title?: string
	readonly fallbackTitle?: string
	readonly type?: "error" | "warning"
}

/** Keeps raw Cause/Exit/error messages in telemetry rather than UI copy. */
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

export const errorMessage = (error: unknown, fallback: string): string => {
	const presentation = formatBackendError(error)
	return presentation.recognized ? presentation.description : fallback
}

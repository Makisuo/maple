import { useId } from "react"
import { Effect } from "effect"
import { toast } from "sonner"

import { Atom, useAtom } from "@/lib/effect-atom"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"

const copyAtom = Atom.family((_instance: string) =>
	Atom.fn(
		Effect.fnUntraced(function* (input: {
			write: () => Promise<void>
			successMessage: string | undefined
			errorMessage: string | undefined
		}) {
			yield* Effect.tryPromise(input.write).pipe(
				Effect.tap(Effect.sync(() => input.successMessage && toast.success(input.successMessage))),
				Effect.tapError(() =>
					Effect.sync(() => input.errorMessage && toast.error(input.errorMessage)),
				),
			)
			// Hold `copied` (= result.waiting) before the atom settles back to rest.
			yield* Effect.sleep("1500 millis")
		}),
	),
)

/**
 * Effect-first copy-to-clipboard: `copied` derives from the copy atom's
 * `waiting` flag, so the indicator hold, auto-reset, and rapid-reclick
 * behavior come from Atom.fn's interrupt-and-rerun semantics — no local
 * state or timers. Toasts are keyed off `label` ("<label> copied" /
 * "Failed to copy <label>"); pass `{ silent: true }` for surfaces that
 * give their own feedback (tooltips, inline check icons), or a per-call
 * `successMessage` when the default needs extra context.
 */
export function useCopyToClipboard(label: string, options?: { silent?: boolean }) {
	const clipboard = useClipboard()
	const [result, invoke] = useAtom(copyAtom(useId()))
	return {
		copied: result.waiting,
		copy: (text: string, copyOptions?: { successMessage?: string }) =>
			invoke({
				write: () => clipboard.copy(text),
				successMessage: options?.silent
					? undefined
					: (copyOptions?.successMessage ?? `${label} copied`),
				errorMessage: options?.silent ? undefined : `Failed to copy ${label}`,
			}),
	}
}

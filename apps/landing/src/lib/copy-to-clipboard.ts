/**
 * Copy-to-clipboard *binding* for the landing site's install snippets.
 *
 * The landing site is Astro with no React islands, so it can't use
 * `@maple/ui`'s `CopyButton` — but it should still behave the same way: the
 * button says it copies, so it copies; the label reverts after a beat; and a
 * blocked clipboard says so rather than silently claiming success. Only the DOM
 * binding is local; the write itself is `@maple/ui`'s, so the insecure-origin
 * fallback has one implementation across the product and the marketing site.
 */

import { writeClipboardText } from "@maple/ui/lib/clipboard"
import { trackLanding } from "./telemetry"

const RESET_MS = 1600

export interface CopyButtonOptions {
	/** Container holding `[data-copy]` elements. Defaults to the whole document. */
	root?: ParentNode
	/** Selector for the `[data-copy]` hosts, relative to `root`. */
	hostSelector: string
	/** Selector for the clickable button inside each host. */
	buttonSelector: string
	/**
	 * Element whose text is swapped for feedback. Defaults to the button itself;
	 * pass a selector when the label lives in a child span.
	 */
	labelSelector?: string
	/** Resting text. Defaults to whatever the label already says — which is what
	 * keeps the translated string intact on reset. */
	idleLabel?: string
	copiedLabel?: string
	errorLabel?: string
	/** Class toggled on the button while the copied state holds. */
	doneClass?: string
}

/**
 * Binds every `[data-copy]` host under `root`. The clipboard payload comes from
 * the host's `data-copy` attribute.
 */
export function bindCopyButtons({
	root = document,
	hostSelector,
	buttonSelector,
	labelSelector,
	idleLabel,
	copiedLabel = "copied",
	errorLabel = "press ⌘C",
	doneClass = "is-done",
}: CopyButtonOptions): void {
	for (const host of root.querySelectorAll<HTMLElement>(hostSelector)) {
		const button = host.matches(buttonSelector)
			? (host as HTMLButtonElement)
			: host.querySelector<HTMLButtonElement>(buttonSelector)
		if (!button) continue

		const label = labelSelector ? button.querySelector<HTMLElement>(labelSelector) : button
		if (!label) continue

		const resting = idleLabel ?? label.textContent ?? ""
		const text = host.dataset.copy ?? ""
		let timer: ReturnType<typeof setTimeout> | undefined

		button.addEventListener("click", async () => {
			const ok = await writeClipboardText(text)
			// Copying the install command is the strongest intent signal the
			// marketing site has — tracked here rather than at each of the four call
			// sites, since this is the one place that knows the copy succeeded.
			trackLanding("install_command_copied", { command: text.slice(0, 120), copied: ok })
			label.textContent = ok ? copiedLabel : errorLabel
			button.classList.toggle(doneClass, ok)

			// A re-click during the hold restarts the window rather than letting the
			// first timer snap the label back early.
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => {
				label.textContent = resting
				button.classList.remove(doneClass)
			}, RESET_MS)
		})
	}
}

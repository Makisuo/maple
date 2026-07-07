import { type Emit, safeEmit } from "./shared"

const MAX_TEXT = 120

/**
 * Capture clicks and input events as session events. Listens in the capture
 * phase so it sees interactions even when the host app calls
 * `stopPropagation()`. Input *values* are never recorded; only the target
 * element. Click target text is omitted when `maskAllText` is set.
 */
export function installInteractionCapture(emit: Emit, maskAllText: boolean): () => void {
	const onClick = (event: Event): void => {
		const target = event.target
		if (!(target instanceof Element)) return
		safeEmit(emit, {
			type: "click",
			targetSelector: selectorOf(target),
			targetText: maskAllText ? undefined : textOf(target),
		})
	}

	const onInput = (event: Event): void => {
		const target = event.target
		if (!(target instanceof Element)) return
		// Never capture the value — only that an input on this element occurred.
		safeEmit(emit, { type: "input", targetSelector: selectorOf(target) })
	}

	document.addEventListener("click", onClick, true)
	document.addEventListener("input", onInput, true)

	return () => {
		document.removeEventListener("click", onClick, true)
		document.removeEventListener("input", onInput, true)
	}
}

/** A short, human-readable selector: tag + #id + .first-class. */
function selectorOf(el: Element): string {
	const tag = el.tagName.toLowerCase()
	const id = el.id ? `#${el.id}` : ""
	const cls =
		typeof el.className === "string" && el.className.trim()
			? `.${el.className.trim().split(/\s+/)[0]}`
			: ""
	return `${tag}${id}${cls}`
}

function textOf(el: Element): string | undefined {
	const text = (el.textContent ?? "").trim().replace(/\s+/g, " ")
	if (!text) return undefined
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

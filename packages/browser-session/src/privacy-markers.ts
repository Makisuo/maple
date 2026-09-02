/**
 * The markup hooks that exclude an element and its subtree from capture.
 *
 * Both are documented to customers (`packages/browser/README.md`,
 * `docs/browser-sdk.md`), so both have to work everywhere capture reads the DOM
 * — rrweb's replay stream and the distilled interaction stream alike. They live
 * here rather than in either capture module because a marker honoured by only
 * one of them is worse than no marker: the page looks redacted and is not.
 */

/** rrweb's default block class. Declared, not assumed, so it stays in step. */
export const BLOCK_CLASS = "rr-block"

/** rrweb leaves `blockSelector` null by default, so this must be passed explicitly. */
export const BLOCK_ATTRIBUTE = "data-rr-block"

export const BLOCK_SELECTOR = `[${BLOCK_ATTRIBUTE}]`

/**
 * Whether `el` sits inside a blocked subtree. Mirrors rrweb's own ancestor
 * check so the two capture paths agree on what is hidden.
 *
 * Walks parents rather than using `closest()`: no string reaches a selector
 * parser, so a malformed marker cannot throw into the host app's event handler.
 */
export const isBlocked = (el: Element | null): boolean => {
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		if (node.classList?.contains(BLOCK_CLASS)) return true
		if (node.hasAttribute?.(BLOCK_ATTRIBUTE)) return true
	}
	return false
}

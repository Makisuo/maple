/**
 * Global test environment shims.
 *
 * `ResizeObserver` is the one that matters: `PlotFrame` measures its own height
 * through one (see `useMeasuredHeight`), so every component test that renders a
 * chart needs it. jsdom does not implement it, and without this the failure is a
 * bare `ReferenceError` from inside a layout effect — which points at the chart
 * layer rather than at the missing browser API.
 *
 * Installed globally rather than per test file: the alternative is remembering
 * to stub it in every suite that happens to mount a chart, which is exactly the
 * kind of thing that gets noticed only when a test starts failing.
 */
if (!("ResizeObserver" in globalThis)) {
	class TestResizeObserver implements ResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	globalThis.ResizeObserver = TestResizeObserver
}

/**
 * `Element.getAnimations`, which jsdom also lacks.
 *
 * Base UI's scroll area calls it while settling a scroll, and it surfaced only
 * once the `ResizeObserver` shim above let chart-bearing trees mount far enough
 * to render one. It throws as an *unhandled* rejection rather than a test
 * failure, so it does not fail a run — it just leaves three errors in every
 * report and is a flake waiting to happen.
 *
 * An empty list is the honest answer: jsdom runs no animations, so there are
 * none to return.
 */
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
	// The `in` guard narrows the prototype to `never`, so the assignment needs a
	// cast — the whole point here is adding a property the type says is absent.
	;(Element.prototype as { getAnimations?: () => Animation[] }).getAnimations = () => []
}

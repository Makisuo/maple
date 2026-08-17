// @vitest-environment jsdom
import { bench, describe } from "vitest"
import { approximateSize } from "../platform/approximate-size"
import type { SessionEvent } from "../events/events-sink"
import { installConsoleCapture } from "../replay/capture/console"
import { installInteractionCapture } from "./interactions"

/**
 * The capture modules sit on host-app hot paths: every `console.log`, every
 * click. This measures what installing them costs the app that installed us,
 * against the same work with capture absent.
 *
 * Read the ratios, not the absolutes — jsdom is not a browser. Run with
 * `bun run bench` in this package.
 *
 * ## What this settled (measured 2026-08-14, M-series, jsdom)
 *
 * A review flagged that a captured console call is serialized three times:
 * `formatArgs` stringifies each argument, `approximateSize` stringifies the
 * whole event again for flush accounting, and `toRow` stringifies a third time
 * at flush. The numbers say that is real but not worth fixing:
 *
 * - console capture adds **~180 ns per call** (51.5M/s → 5.0M/s against a
 *   no-op sink). Against a *real* console write — far more expensive than the
 *   no-op measured here — the same overhead is ~7%.
 * - `approximateSize` is ~120 ns of that 180 ns, so the redundant pass really
 *   is most of the cost. It is still 120 ns.
 * - an app logging 100 lines a second therefore pays ~18 µs/s: about 0.002% of
 *   one core.
 * - click capture adds ~0.5 µs per click (1.19x), which at human click rates
 *   is unmeasurable.
 *
 * So the third serialization stays. Removing it would trade a genuinely tricky
 * size-estimation path (the fallback exists because events can contain cycles)
 * for a saving no user can perceive. Revisit if capture ever moves onto a path
 * that runs thousands of times a second — long stacks are the one shape that
 * gets expensive, at ~800 ns.
 */

const noopEmit = (_ev: SessionEvent): void => {}

describe("console capture", () => {
	const args: unknown[] = [
		"user action failed",
		{ userId: "u_1", org: "acme", attempt: 3, nested: { a: 1, b: [1, 2, 3] } },
		new Error("boom"),
	]

	// The real `console.log` is stubbed to a no-op for the whole suite. Both arms
	// then perform the same underlying write, so the delta between them is our
	// wrapper and nothing else — and the bench run does not spew the sample
	// payload thousands of times into the reporter.
	const realLog = console.log
	const stub = (): void => {
		console.log = () => {}
	}
	const unstub = (): void => {
		console.log = realLog
	}

	let uninstall: (() => void) | undefined

	bench(
		"console.log, capture absent",
		() => {
			console.log(...args)
		},
		{ setup: stub, teardown: unstub },
	)

	bench(
		"console.log, capture installed",
		() => {
			console.log(...args)
		},
		{
			// Installed once, outside the measured body: an app pays the patch cost
			// at init, not per call.
			setup: () => {
				stub()
				uninstall = installConsoleCapture(noopEmit)
			},
			teardown: () => {
				uninstall?.()
				uninstall = undefined
				unstub()
			},
		},
	)

	// The distilled event is serialized once to format the message, again by
	// `approximateSize` for flush accounting, and a third time at flush. This
	// isolates the second one, which is the pass that could be dropped.
	bench("approximateSize of a console event", () => {
		approximateSize({
			type: "console",
			level: "log",
			message: 'user action failed {"userId":"u_1","org":"acme"} Error: boom',
		})
	})
})

describe("interaction capture", () => {
	const button = document.createElement("button")
	button.id = "save"
	button.className = "btn btn-primary"
	button.textContent = "Save changes"
	document.body.appendChild(button)

	let uninstall: (() => void) | undefined

	bench("click, capture absent", () => {
		button.click()
	})

	bench(
		"click, capture installed",
		() => {
			button.click()
		},
		{
			setup: () => {
				uninstall = installInteractionCapture(noopEmit, false)
			},
			teardown: () => {
				uninstall?.()
				uninstall = undefined
			},
		},
	)
})

describe("approximateSize by payload shape", () => {
	const small: SessionEvent = { type: "click", targetSelector: "button#save" }
	const network: SessionEvent = {
		type: "network",
		net: { method: "POST", url: "https://api.example.com/v1/orders", status: 201, durationMs: 143 },
	}
	const large: SessionEvent = {
		type: "error",
		level: "error",
		message: "Unhandled rejection",
		errorStack: "Error: boom\n".repeat(120),
	}

	bench("small click event", () => {
		approximateSize(small)
	})
	bench("network event", () => {
		approximateSize(network)
	})
	bench("error with a long stack", () => {
		approximateSize(large)
	})
})

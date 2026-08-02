import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { useCopy, type CopyAPI, type UseCopyOptions } from "./use-copy"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function Probe({ options, onReady }: { options?: UseCopyOptions; onReady: (api: CopyAPI) => void }) {
	const api = useCopy(options)
	onReady(api)
	return <span data-testid="status">{api.status}</span>
}

/** Renders the hook and returns a getter for its latest API surface. */
function mount(options?: UseCopyOptions) {
	let latest!: CopyAPI
	const view = render(<Probe options={options} onReady={(api) => (latest = api)} />)
	return {
		get api() {
			return latest
		},
		view,
	}
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
	// The sonner mock is module-level, so its call log outlives `restoreAllMocks`.
	vi.clearAllMocks()
	vi.useFakeTimers()
	writeText = vi.fn().mockResolvedValue(undefined)
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	})
	// The `execCommand` fallback must not rescue a deliberately failing write.
	Object.defineProperty(document, "execCommand", { configurable: true, value: () => false })
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("useCopy", () => {
	it("holds `copied` for the timeout, then falls back to idle", async () => {
		const probe = mount({ timeout: 2000 })
		expect(probe.api.status).toBe("idle")

		await act(async () => {
			await probe.api.copy("maple")
		})
		expect(writeText).toHaveBeenCalledWith("maple")
		expect(probe.api.status).toBe("copied")
		expect(probe.api.copied).toBe(true)

		act(() => vi.advanceTimersByTime(1999))
		expect(probe.api.status).toBe("copied")

		act(() => vi.advanceTimersByTime(1))
		expect(probe.api.status).toBe("idle")
	})

	it("reports `error` when the write is rejected and the fallback also fails", async () => {
		const onError = vi.fn()
		writeText.mockRejectedValue(new Error("denied"))
		const probe = mount({ onError })

		await act(async () => {
			expect(await probe.api.copy("maple")).toBe(false)
		})
		expect(probe.api.status).toBe("error")
		expect(probe.api.copied).toBe(false)
		expect(onError).toHaveBeenCalledOnce()
	})

	it("succeeds through the execCommand fallback when the clipboard API rejects", async () => {
		// The path that only ever runs on insecure origins and embedded contexts —
		// i.e. never in a developer's browser, so it needs a test more than the
		// happy path does.
		const onCopy = vi.fn()
		writeText.mockRejectedValue(new Error("denied"))
		Object.defineProperty(document, "execCommand", { configurable: true, value: () => true })
		const probe = mount({ label: "Trace ID", onCopy })

		await act(async () => {
			expect(await probe.api.copy("maple")).toBe(true)
		})
		expect(probe.api.status).toBe("copied")
		expect(onCopy).toHaveBeenCalledWith("maple")
		expect(toast.success).toHaveBeenCalledWith("Trace ID copied")
		expect(toast.error).not.toHaveBeenCalled()
	})

	it("treats an empty value as an error rather than a silent success", async () => {
		const probe = mount()

		await act(async () => {
			expect(await probe.api.copy("")).toBe(false)
		})
		expect(writeText).not.toHaveBeenCalled()
		expect(probe.api.status).toBe("error")
	})

	it("restarts the hold window when copied again mid-hold", async () => {
		const probe = mount({ timeout: 2000 })

		await act(async () => {
			await probe.api.copy("first")
		})
		act(() => vi.advanceTimersByTime(1500))
		expect(probe.api.status).toBe("copied")

		await act(async () => {
			await probe.api.copy("second")
		})
		// Had the first timer survived, this would have reset at 2000ms total.
		act(() => vi.advanceTimersByTime(1500))
		expect(probe.api.status).toBe("copied")

		act(() => vi.advanceTimersByTime(500))
		expect(probe.api.status).toBe("idle")
	})

	it("stays silent only when `toast` is explicitly disabled", async () => {
		const probe = mount({ label: "Trace ID", toast: false })

		await act(async () => {
			await probe.api.copy("abc")
		})
		expect(toast.success).not.toHaveBeenCalled()
	})

	it("toasts on both outcomes by default", async () => {
		const probe = mount({ label: "Trace ID" })

		await act(async () => {
			await probe.api.copy("abc")
		})
		expect(toast.success).toHaveBeenCalledWith("Trace ID copied")

		writeText.mockRejectedValue(new Error("denied"))
		await act(async () => {
			await probe.api.copy("abc")
		})
		expect(toast.error).toHaveBeenCalledWith("Failed to copy trace id")
	})

	it("falls back to a generic toast when no label is given", async () => {
		const probe = mount()

		await act(async () => {
			await probe.api.copy("abc")
		})
		expect(toast.success).toHaveBeenCalledWith("Copied to clipboard")
	})

	it("`reset` clears the state immediately", async () => {
		const probe = mount()

		await act(async () => {
			await probe.api.copy("maple")
		})
		expect(probe.api.status).toBe("copied")

		act(() => probe.api.reset())
		expect(probe.api.status).toBe("idle")
	})
})

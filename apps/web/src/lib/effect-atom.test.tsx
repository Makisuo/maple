// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result, useAtomValue } from "@/lib/effect-atom"
import { retainResult } from "@/lib/services/atoms/result-retention"
import { withRetention } from "@/lib/services/atoms/retained-atom"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { type ReactNode, useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

function createWrapper() {
	const registry = Registry.make()

	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

type Rows = { rows: string[] }

const successAtom = Atom.make(Result.success<Rows>({ rows: ["ready"] }))
const initialAtom = Atom.make(Result.initial<Rows, never>())
const failureAtom = Atom.make(Result.fail<string, Rows>("boom"))

function ResultHarness({ next }: { next: Atom.Atom<Result.Result<Rows, string>> }) {
	const [current, setCurrent] = useState<Atom.Atom<Result.Result<Rows, string>>>(successAtom)
	const result = useAtomValue(current)

	return (
		<div>
			<button onClick={() => setCurrent(next)}>swap</button>
			<div data-testid="state">{result._tag}</div>
			<div data-testid="waiting">{String(result.waiting)}</div>
			<div data-testid="row">
				{Result.builder(result)
					.onSuccess((value) => value.rows[0] ?? "none")
					.orElse(() => "none")}
			</div>
		</div>
	)
}

describe("useAtomValue", () => {
	afterEach(() => {
		cleanup()
		setActiveOrgId(null)
	})

	it("keeps the last success on screen while the next atom is initial", async () => {
		render(<ResultHarness next={initialAtom} />, { wrapper: createWrapper() })

		expect(screen.getByTestId("row").textContent).toBe("ready")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "swap" }))
		})

		// The filter-rail case: the page marks itself busy instead of unmounting
		// the rows into a skeleton.
		expect(screen.getByTestId("state").textContent).toBe("Success")
		expect(screen.getByTestId("waiting").textContent).toBe("true")
		expect(screen.getByTestId("row").textContent).toBe("ready")
	})

	it("does not paper over a failure with the retained success", async () => {
		render(<ResultHarness next={failureAtom} />, { wrapper: createWrapper() })

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "swap" }))
		})

		expect(screen.getByTestId("state").textContent).toBe("Failure")
		expect(screen.getByTestId("row").textContent).toBe("none")
	})

	it("drops the retained success when the active org changes", async () => {
		setActiveOrgId("org_a")
		render(<ResultHarness next={initialAtom} />, { wrapper: createWrapper() })

		expect(screen.getByTestId("row").textContent).toBe("ready")

		await act(async () => {
			setActiveOrgId("org_b")
			fireEvent.click(screen.getByRole("button", { name: "swap" }))
		})

		// Showing the previous org's rows — even dimmed — is the leak org-scoped
		// atom keys exist to prevent.
		expect(screen.getByTestId("state").textContent).toBe("Initial")
		expect(screen.getByTestId("row").textContent).toBe("none")
	})

	it("passes non-result atoms through untouched", () => {
		const countAtom = Atom.make(7)

		function CountHarness() {
			return <div data-testid="count">{useAtomValue(countAtom)}</div>
		}

		render(<CountHarness />, { wrapper: createWrapper() })
		expect(screen.getByTestId("count").textContent).toBe("7")
	})

	// Regression for the production /errors crash (React #301, 2026-08-25):
	// `retainedQuery`/`retainedQueryV2` call `withRetention` in the component
	// body, so the wrapper atom is rebuilt every render. While the underlying
	// query atom is Initial and a retained entry exists, every rebuilt wrapper
	// served a fresh `waiting(success)` object — and the retention hook's
	// setState-during-render saw a new identity each pass, looping until React
	// threw "Too many re-renders".
	it("survives a retention wrapper rebuilt on every render while serving a fallback", async () => {
		retainResult("effect-atom-test:loop", { rows: ["retained"] }, Date.now())
		const primary = Atom.make(Result.initial<Rows, never>())

		function RebuiltWrapperHarness() {
			const result = useAtomValue(withRetention(primary, "effect-atom-test:loop"))
			const [, bump] = useState(0)

			return (
				<div>
					<button onClick={() => bump((n) => n + 1)}>rerender</button>
					<div data-testid="loop-row">
						{Result.builder(result)
							.onSuccess((value) => value.rows[0] ?? "none")
							.orElse(() => "none")}
					</div>
				</div>
			)
		}

		render(<RebuiltWrapperHarness />, { wrapper: createWrapper() })
		expect(screen.getByTestId("loop-row").textContent).toBe("retained")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "rerender" }))
		})
		expect(screen.getByTestId("loop-row").textContent).toBe("retained")
	})
})

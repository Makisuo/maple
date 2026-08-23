// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result, useAtomValue } from "@/lib/effect-atom"
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
})

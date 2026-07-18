// @vitest-environment jsdom

import { Event, Model, Registry, Store, UnitflowRuntime } from "@maple/unitflow"
import { Unitflow, View } from "@maple/unitflow/react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"

class ReactBindingModel extends Model.Service<ReactBindingModel>()("/test/web/ReactBindingModel")({
	make: () =>
		Effect.gen(function* () {
			const count = Store.make(0)
			const increment = Event.make<number>()
			yield* Registry.run(
				Event.stream(increment).pipe(
					Stream.tap((amount) => Store.update(count, (current) => current + amount)),
				),
			)
			return {
				inputs: { increment },
				outputs: { count },
				ui: { count, increment },
			}
		}),
}) {}

const CounterView = View.make(ReactBindingModel, ({ count, increment }) => (
	<button onClick={() => increment(1)}>{count}</button>
))

describe("Unitflow React view binding", () => {
	let runtime: UnitflowRuntime.UnitflowRuntime<any, any> | undefined

	afterEach(async () => {
		cleanup()
		await runtime?.dispose()
		runtime = undefined
	})

	it("binds store and event ports without changing hook order", async () => {
		const testRuntime = UnitflowRuntime.make(ReactBindingModel.layer)
		runtime = testRuntime
		render(
			<Unitflow runtime={testRuntime} rootModel={ReactBindingModel}>
				{(unit) => <CounterView unit={unit} />}
			</Unitflow>,
		)

		const counter = await screen.findByRole("button", { name: "0" })
		fireEvent.click(counter)
		expect(await screen.findByRole("button", { name: "1" })).toBe(counter)
	})
})

import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { makeAppRuntime } from "./make-app-runtime"

class TestClient extends Context.Service<TestClient, { readonly acquisition: number }>()(
	"@maple/web/test/TestClient",
) {}

describe("makeAppRuntime", () => {
	it("reuses layers already acquired by the atom runtime", async () => {
		let acquisitions = 0
		const clientLayer = Layer.effect(
			TestClient,
			Effect.sync(() => ({ acquisition: ++acquisitions })),
		)
		const memoMap = Layer.makeMemoMapUnsafe()
		const atomRuntime = ManagedRuntime.make(clientLayer, { memoMap })
		const appRuntime = makeAppRuntime(clientLayer, memoMap)

		try {
			const atomClient = await atomRuntime.runPromise(TestClient)
			const appClient = await appRuntime.runPromise(TestClient)

			assert.strictEqual(appRuntime.memoMap, memoMap)
			assert.strictEqual(appClient, atomClient)
			assert.strictEqual(acquisitions, 1)
		} finally {
			await appRuntime.dispose()
			await atomRuntime.dispose()
		}
	})
})

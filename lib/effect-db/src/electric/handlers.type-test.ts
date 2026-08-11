import type { Row } from "@electric-sql/client"
import type { ManagedRuntime } from "effect"
import { convertDeleteHandler, convertInsertHandler, convertUpdateHandler } from "./handlers"
import type { EffectDeleteHandler, EffectInsertHandler, EffectUpdateHandler } from "./types"

type TestRow = Row<unknown>
type TestUtils = Record<string, never>
interface TestRequirement {
	readonly _tag: "TestRequirement"
}

declare const insert: EffectInsertHandler<TestRow, string, TestUtils, never, TestRequirement>
declare const update: EffectUpdateHandler<TestRow, string, TestUtils, never, TestRequirement>
declare const remove: EffectDeleteHandler<TestRow, string, TestUtils, never, TestRequirement>
declare const runtime: ManagedRuntime.ManagedRuntime<TestRequirement, unknown>

convertInsertHandler(insert, runtime)
convertUpdateHandler(update, runtime)
convertDeleteHandler(remove, runtime)

// @ts-expect-error A handler with requirements must supply the matching runtime.
convertInsertHandler(insert)
// @ts-expect-error A handler with requirements must supply the matching runtime.
convertUpdateHandler(update)
// @ts-expect-error A handler with requirements must supply the matching runtime.
convertDeleteHandler(remove)

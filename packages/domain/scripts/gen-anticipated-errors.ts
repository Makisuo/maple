// Regenerates src/generated/anticipated-error-identifiers.ts from the error
// classes themselves (see src/anticipated-errors-derive.ts for the derivation).
// Run with: bun run gen:anticipated-errors
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { deriveAnticipatedIdentifiers } from "../src/anticipated-errors-derive"

const identifiers = [...deriveAnticipatedIdentifiers()].sort()

const file = `// GENERATED FILE — do not edit by hand.
//
// Anticipated (4xx) error identifiers, derived by reflection over the domain
// HTTP error classes. Regenerate with \`bun run gen:anticipated-errors\` in
// packages/domain after adding or re-annotating an HTTP error; the drift test
// in anticipated-errors.test.ts fails until you do.
//
// Kept as a literal list so the worker entrypoint can build the set at isolate
// startup without evaluating the whole domain HTTP schema surface.
export const ANTICIPATED_ERROR_IDENTIFIER_LIST: ReadonlyArray<string> = [
${identifiers.map((id) => `\t${JSON.stringify(id)},`).join("\n")}
]
`

const target = join(import.meta.dirname, "../src/generated/anticipated-error-identifiers.ts")
writeFileSync(target, file)
console.log(`wrote ${identifiers.length} identifiers to ${target}`)

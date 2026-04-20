This is the Effect library repository, focusing on functional programming patterns and effect systems in TypeScript.

- The git base branch is `main`
- Use `pnpm` as the package manager
- Run `pnpm lint-fix` after editing files
- Always run tests after making changes: `pnpm test <test_file.ts>`
- Run type checking: `pnpm check:tsgo`
  - If type checking continues to fail, run `pnpm clean` to clear caches, then re-run `pnpm check:tsgo`
- Check JSDoc examples compile: when changes are localized to a single package, `cd` into that package directory and run `pnpm docgen` within it instead of running it at the root

## Code Style Guidelines

You **MUST** look at the `./.patterns/` directory as well as existing code in
the repository to learn and follow established patterns before writing new code.

## Prefer `Effect.fnUntraced` over functions that return `Effect.gen`

Instead of writing:

```ts
const fn = (param: string) =>
  Effect.gen(function*() {
    // ...
  })
```

Prefer:

```ts
const fn = Effect.fnUntraced(function*(param: string) {
  // ...
})
```

## Using `Context.Service`

Prefer the class syntax when working with `Context.Service`. For example:

```ts
import { Context } from "effect"

class MyService extends Context.Service<MyService, {
  readonly doSomething: (input: string) => number
}>()("MyService") {}
```

## Never use async / await or try / catch

Instead use `Effect` apis like `Effect.fnUntraced`, `Effect.gen`,
`Effect.tryPromise` etc.

Look at existing code in the repository to learn and follow established patterns

## Never use Date.now or new Date

Instead use the `Clock` module, and `TestClock` for adjusting time in tests.

## Barrel files

The `index.ts` files are automatically generated. Do not manually edit them. Use
`pnpm codegen` to regenerate barrel files after adding or removing modules.

## Running test code

If you need to run some code for testing or debugging purposes, create a new
file in the `scratchpad/` directory at the root of the repository. You can then
run the file with `node scratchpad/your-file.ts`.

Make sure to delete the file after you are done testing.

## Testing

Before writing tests, always look at existing tests in the codebase for similar
functionality to follow established patterns.

- Test files are located in `packages/*/test/` directories for each package
- Main Effect library tests: `packages/effect/test/`
- Always verify implementations with tests
- Run specific tests with: `pnpm test <filename>`

### it.effect Testing Pattern

- Use `it.effect` for all Effect-based tests, not `Effect.runSync` with regular `it`
- Import `{ assert, describe, it }` from `@effect/vitest`
- Never use `expect` from vitest in Effect tests - use `assert` methods instead
- All tests should use `it.effect("description", () => Effect.gen(function*() { ... }))`

### Type level tests

Type level tests are located in the `packages/*/typetest` directories of each package.

You can run them with `pnpm test-types <filename>`.

Take a look at the existing `.tst.ts` files for examples of how to write type
level tests. They use the `tstyche` testing library.

## Writing AI documentation

Refer to `ai-docs/README.md` for instructions on how to write AI documentation.
Read it very carefully before writing AI documentation examples.

AI documentation changes can ignore the "Reduce comments" guideline. You can add
comments to AI documentation examples as needed to explain the code.

## Changesets

All pull requests must include a changeset. You can create changesets in the
`.changeset/` directory.

The have the following format:

```md
---
"package-name": patch | minor | major
---

A description of the change.
```

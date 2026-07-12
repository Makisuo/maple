# Effect Type Performance

This harness measures TypeScript type instantiations for focused fixtures.

Use it when a Schema type-level change needs a small regression guard for the
specific type path that was optimized.

## Core Model

Each suite has one shared baseline. Fixture cost is reported as:

```txt
delta = fixture instantiations - suite baseline instantiations
```

The runner compiles each baseline and fixture as an isolated TypeScript program
by generating temporary `tsconfig` files under `tmp/typeperf`.

Fixtures must use realistic package imports:

```ts
import { Schema } from "effect"
```

Do not import source files directly, for example do not use
`../../src/Schema.ts`. The package self-reference should resolve the public
`effect` package entry.

Every fixture in a suite should repeat the suite warmup expression from
`baseline.ts`. For the current Schema suite, that means:

```ts
import { Schema } from "effect"

Schema.String
```

## Commands

From the repository root:

```sh
pnpm typeperf
pnpm typeperf schema
pnpm typeperf schema/struct-required
pnpm typeperf --update
pnpm typeperf schema/struct-required --update
```

Without a target, the runner checks every suite and fixture. A target can be a
suite name (`schema`) or an individual fixture (`schema/struct-required`).

`--update` writes exact measured deltas to threshold files. When a target is
provided, only the selected suite or fixture is updated.

## Adding A Fixture

Add a fixture when a change optimizes one specific constructor, helper, or
type-level path.

1. Create one file under the suite's `fixtures/` directory.
2. Name it after the isolated behavior being measured, for example
   `struct-optional-only.ts`.
3. Add a first-line comment explaining the single thing being measured.
4. Use realistic package imports.
5. Repeat the suite warmup expression.
6. Build only the schema needed for that one behavior.
7. Export type aliases that force TypeScript to instantiate the views under
   test.
8. Add the fixture to `config.json`.
9. Run `pnpm typeperf <suite>/<fixture> --update`.
10. Run `pnpm typeperf <suite>/<fixture>`.

Example:

```ts
// Measures the marginal type-level cost of Schema.Struct when all fields are optional keys.
import { Schema } from "effect"

Schema.String

const schema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.NumberFromString)
})

export type Type = typeof schema.Type
export type Encoded = typeof schema.Encoded
export type Iso = typeof schema.Iso
export type MakeIn = typeof schema["~type.make.in"]
```

Then register it:

```json
{
  "name": "struct-optional-only",
  "file": "suites/schema/fixtures/struct-optional-only.ts"
}
```

### Fixture Rules

- Measure one thing per fixture. Split separate paths into separate files.
- Keep inputs realistic, but not large for its own sake.
- Export the minimum type aliases needed to force the type computation being
  measured.
- Do not combine multiple optimized APIs just to make the fixture look like an
  application model.
- Do not add fixtures for unchanged or unrelated APIs.
- Do not add fixture files to `packages/effect/tsconfig.json`; `pnpm typeperf`
  compiles them independently.
- If a fixture fails to compile, fix the fixture or source types. Do not hide
  the problem by aggregating it with another fixture.

## Adding A Suite

Add a suite when fixtures need a different shared baseline. For example,
Schema-specific fixtures share the `schema` baseline, while a future HTTP API
suite may need a different import and warmup.

1. Create `suites/<suite-name>/baseline.ts`.
2. Create `suites/<suite-name>/fixtures/`.
3. Create `suites/<suite-name>/thresholds.json` with `{}`.
4. Add a suite entry to `config.json`.
5. Add at least one focused fixture.
6. Run `pnpm typeperf <suite-name> --update`.
7. Run `pnpm typeperf <suite-name>`.

Example suite entry:

```json
{
  "name": "schema",
  "baseline": "suites/schema/baseline.ts",
  "thresholds": "suites/schema/thresholds.json",
  "fixtures": [
    {
      "name": "struct-required",
      "file": "suites/schema/fixtures/struct-required.ts"
    }
  ]
}
```

The baseline should contain only the import and warmup common to every fixture in
that suite. If a fixture needs extra setup that others do not need, put that
setup in the fixture, not in the shared baseline.

## Updating Thresholds

Use `--update` only after verifying that the measured delta is expected.

```sh
pnpm typeperf schema/struct-required --update
pnpm typeperf schema/struct-required
```

`--update` writes the exact measured delta as `maxDelta`. It does not add a
margin.

## Validation Checklist

After adding or changing fixtures:

```sh
pnpm typeperf <suite>/<fixture> --update
pnpm typeperf <suite>/<fixture>
pnpm exec dprint check package.json packages/effect/typeperf
```

Run the broader suite when the change touches shared runner behavior:

```sh
pnpm typeperf <suite>
```

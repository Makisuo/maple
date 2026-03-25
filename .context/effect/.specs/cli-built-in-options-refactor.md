# CLI Built-in Options Refactor: Command-Scoped Global Flags

**Issue**: https://github.com/Effect-TS/effect-smol/issues/1441\
**Status**: Draft for implementation\
**Approach**: command-scoped global flag declarations via `Command.withGlobalFlags`

---

## Summary

Replace runtime-global registry mutation (`GlobalFlag.add/remove/clear`) with
static command-tree declarations.

Goals:

1. Keep built-ins visible in help under "GLOBAL FLAGS"
2. Keep custom global flags extensible
3. Make setting defaults come from `Flag` combinators (`optional`, `withDefault`)
4. Fix type hole where `yield* Setting` compiles even if setting not registered

Core decision:

- Global flags are declared on commands, not injected at runtime into `run` effects
- Scope is lexical in command tree: declaration applies to command + descendants

---

## Scope Semantics (Precise)

Given command path `root -> ... -> leaf`, active global flags are:

- Union of declarations on each node along that selected path
- Ordered by path order (root first, then deeper nodes), preserving declaration order per node

Visibility rules:

- Declared on `root`: visible to `root` and all descendants
- Declared on `deploy` subcommand: visible to `deploy` subtree only
- Not visible to ancestors
- Not visible to siblings

Example:

```ts
const Color = GlobalFlag.setting("color")({
  flag: Flag.string("color").pipe(Flag.withDefault("blue"))
})
const Region = GlobalFlag.setting("region")({
  flag: Flag.string("region").pipe(Flag.withDefault("us-east-1"))
})

const deploy = Command.make("deploy").pipe(
  Command.withGlobalFlags([Region])
)

const db = Command.make("db")

const app = Command.make("app").pipe(
  Command.withGlobalFlags([Color]),
  Command.withSubcommands([deploy, db])
)
```

Behavior:

- `app deploy`: can use/read `Color` and `Region`
- `app db`: can use/read `Color`; `Region` is invalid
- `app`: can use/read `Color`; `Region` is invalid

---

## Core Model

Two global flag variants remain:

```ts
type GlobalFlag<A> =
  | GlobalFlag.Action<A>
  | GlobalFlag.Setting<A>
```

- `Action`: side effect + exit (`--help`, `--version`, `--completions`)
- `Setting`: parsed value available to handler environment (`--log-level`, custom config)

### Constructors

```ts
const action = <A>(options: {
  readonly flag: Flag.Flag<A>
  readonly run: (value: A, context: HandlerContext) => Effect.Effect<void>
}) => Action<A>

const setting = <const Id extends string>(
  id: Id
) =>
<A>(options: {
  readonly flag: Flag.Flag<A>
}) => Setting<Id, A>
```

`Setting` has no constructor `defaultValue`. Defaults come from the `Flag` itself.
`id` provides stable type-level identity so missing `withGlobalFlags` declarations
surface as type errors. Type-level identifier format:
`effect/unstable/cli/GlobalFlag/${id}`.

---

## Public API Changes

### New/Primary

```ts
const withGlobalFlags: {
  <const Flags extends ReadonlyArray<GlobalFlag<any>>>(
    flags: Flags
  ): <Name extends string, Input, E, R>(
    self: Command<Name, Input, E, R>
  ) => Command<Name, Input, E, R>

  <Name extends string, Input, E, R, const Flags extends ReadonlyArray<GlobalFlag<any>>>(
    self: Command<Name, Input, E, R>,
    flags: Flags
  ): Command<Name, Input, E, R>
}
```

Note: generic details for setting-read requirements are internal typing detail;
API contract is that declaration is required for safe setting access.

### Removed (Breaking)

- `GlobalFlag.add`
- `GlobalFlag.remove`
- `GlobalFlag.clear`

Reason: runtime mutation cannot guarantee compile-time correctness for setting reads.

---

## Execution Pipeline

`runWith` flow:

1. Lex argv
2. Collect all declared global flag params across command tree (for token consumption)
3. Consume known global flag tokens into `flagMap`
4. Parse command/subcommand args from remainder, obtain selected `commandPath`
5. Compute active globals from declarations along `commandPath`
6. Validate scope: if token consumed for a global not active on `commandPath`, fail as invalid/unrecognized for path
7. Execute action globals: first present active action wins, run then exit
8. Parse command config
9. Parse active settings and provide them to handler context
10. Apply built-in setting behavior (`LogLevel` => `References.MinimumLogLevel`)
11. Run handler

Action precedence:

- First present action in active-global order wins
- Active-global order = root-to-leaf declaration order

Presence rule:

- Action considered present only if user passed its token(s)
- No activation by default values

---

## Settings: Defaults and Access

Defaults:

- `Flag.optional` => setting value absent/present modeled by `Option`
- `Flag.withDefault(x)` => setting value always resolved to `x` when flag omitted
- `Flag.withDefault(effect)` => effectful default supported by flag parser

No duplicate default declaration in `GlobalFlag.setting`.

Access:

- Existing ergonomic read (`yield* MySetting`) remains supported
- If setting is read outside a command path where it is declared, runtime fails with explicit missing-setting error
- Type-level goal: declaration via `withGlobalFlags` discharges setting requirement

---

## Built-ins

Built-ins remain modeled as global flags:

- `Help` (`Action<boolean>`)
- `Version` (`Action<boolean>`)
- `Completions` (`Action<Option<...>>`)
- `LogLevel` (`Setting<Option<LogLevel>>`)

Default behavior:

- Built-ins declared at root command scope by default
- Therefore visible throughout tree unless explicit future opt-out API is added

`LogLevel` default behavior is flag-driven (`Flag.optional`), no constructor default.

---

## Help Generation

Help must render global flags active for requested help path.

Rules:

- `app --help` => globals declared on `app`
- `app deploy --help` => globals declared on `app` + `deploy`
- Do not show globals declared only on sibling branches

Formatter section order remains:

1. DESCRIPTION
2. USAGE
3. FLAGS
4. GLOBAL FLAGS
5. SUBCOMMANDS
6. EXAMPLES

---

## Validation Rules

1. Detect duplicate flag names among active command flags + active globals for path
2. `--region` passed on `app db` when `Region` declared only on `deploy` must fail
3. Action flags do not run if out of scope for selected path

Error text should name command path and offending flag.

---

## Migration Notes (Breaking)

### Before

```ts
Command.run(app, { version: "1.0.0" }).pipe(
  GlobalFlag.add(MySetting)
)
```

### After

```ts
const app = Command.make("app").pipe(
  Command.withGlobalFlags([MySetting])
)

Command.run(app, { version: "1.0.0" })
```

### Setting constructor

Before:

```ts
GlobalFlag.setting("x")({
  flag: Flag.string("x").pipe(Flag.optional),
  defaultValue: () => Option.none()
})
```

After:

```ts
GlobalFlag.setting("x")({
  flag: Flag.string("x").pipe(Flag.optional)
})
```

---

## Testing Strategy

1. Built-ins still work globally (`--help`, `--version`, `--completions`, `--log-level`)
2. Path scope semantics:
   - root-declared global visible in child
   - child-declared global not visible in parent/sibling
3. Out-of-scope token validation (`app db --region` fails if `region` only on `deploy`)
4. `Flag.withDefault` on setting resolves when omitted
5. `Flag.optional` on setting resolves `Option.none` when omitted
6. Action precedence respects root-to-leaf declaration order
7. Help output shows only globals active for requested path

---

## Ordered Task List

1. Add `Command.withGlobalFlags` combinator and storage in command internals
2. Remove runtime mutation APIs (`GlobalFlag.add/remove/clear`) and usages
3. Update `runWith` to compute active globals from selected command path
4. Add out-of-scope global token validation
5. Keep action-first-exit behavior on active globals only
6. Keep setting parse/provide behavior driven by `Flag` combinators
7. Update help generation to show path-active globals
8. Update tests + snapshots for scope semantics and migration
9. Run full validation (`lint-fix`, targeted tests, `check`, `build`, `docgen`)

---

## Open Questions

1. Need explicit API to opt out built-ins on subtree?
2. Allow child to override parent global with same flag name, or hard error?
3. Exact error category for out-of-scope globals: UnknownOption vs dedicated error?

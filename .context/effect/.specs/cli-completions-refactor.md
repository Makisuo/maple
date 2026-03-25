# CLI Completions Refactor

## Summary

Replace the current dynamic (re-invoke the CLI) shell completions system with a
static completions generator that produces self-contained Bash, Zsh, and Fish
completion scripts directly from the command tree at build time. Rewrite the
implementation as clean, idiomatic Effect code and add a comprehensive test
suite.

## Background

The current completions implementation lives in
`packages/effect/src/unstable/cli/internal/completions/` and uses a **dynamic**
approach: shell completion scripts call the CLI binary at runtime with
`--get-completions` and special environment variables (`COMP_CWORD`,
`COMP_LINE`, `COMP_POINT`). The CLI process inspects these variables, walks the
command tree, and prints matching completions to stdout.

### Problems with the current approach

1. **Dynamic re-invocation is fragile.** Completions depend on the CLI binary
   being available in `$PATH`, importing and initializing successfully, and
   responding within the shell's completion timeout. Slow startup (e.g. loading
   large dependency graphs) degrades the tab-completion experience.

2. **Process-global mutation in tests.** The handler reads and writes
   `process.env` and `process.argv` directly. Tests must save/restore global
   state, making them non-composable and race-prone.

3. **Incomplete coverage.** The current system only completes flags and
   subcommands. Positional arguments, choice values, file/directory type hints,
   and boolean negation (`--no-*`) are not surfaced.

4. **Non-idiomatic code.** The implementation uses imperative mutation
   (`Map`, `push`, manual loops), `process.env` access, raw `console.log`
   output, and ad-hoc string concatenation for shell scripts. None of it uses
   Effect types or patterns.

5. **Shell scripts are string templates with variable interpolation.** The bash,
   zsh, and fish generators are large template literals with no structure or
   testability.

## Goals

- Generate **static** completion scripts for Bash, Zsh, and Fish that contain
  all completion data inline — no re-invocation of the CLI binary at runtime.
- Support completions for:
  - Subcommands (with descriptions)
  - Long flags (`--flag`) and short aliases (`-f`)
  - Boolean flag negation (`--no-flag`)
  - Flag value types (file, directory, path hints for shell-native completion)
  - Choice/enum values for flags and arguments
  - Positional arguments with type hints
- Produce clean, idiomatic Effect code throughout.
- Comprehensive test suite covering all three shells and all completion
  scenarios.

## Non-goals

- No dynamic/runtime completion mode. The `--get-completions` flag and
  `COMP_*`/`FISH_COMPLETION` environment variable handling will be removed.
- No interactive prompt completions (the `Prompt` module is separate).
- No custom completion functions or async data sources. Static scripts only.
- No changes to the `Command`, `Flag`, `Argument`, or `Param` public APIs
  (only internal reads of existing metadata).

---

## Design

### Architecture overview

```
Command tree
    │
    ▼
CommandDescriptor.fromCommand(cmd)    ← Extract completion metadata
    │
    ▼
CommandDescriptor (pure data)         ← Shell-agnostic intermediate representation
    │
    ├─► Bash.generate(descriptor)     ← Shell-specific script generators
    ├─► Zsh.generate(descriptor)
    └─► Fish.generate(descriptor)
          │
          ▼
        string                        ← Complete shell script, ready to eval
```

The system has three layers:

1. **Descriptor extraction** — walks the `Command` tree and extracts a pure-data
   `CommandDescriptor` containing everything needed for completions.
2. **Shell generators** — take a `CommandDescriptor` and produce a complete,
   self-contained shell script as a string.
3. **Integration** — the existing `--completions <shell>` built-in flag calls
   the appropriate generator and prints the result.

### 1. CommandDescriptor — completion metadata

A pure data structure extracted from the command tree. No Effect types, no
parsing logic — just the information shells need.

```ts
interface CommandDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly flags: ReadonlyArray<FlagDescriptor>
  readonly arguments: ReadonlyArray<ArgumentDescriptor>
  readonly subcommands: ReadonlyArray<CommandDescriptor>
}

interface FlagDescriptor {
  readonly name: string // long name without --
  readonly aliases: ReadonlyArray<string> // short aliases without -
  readonly description: string | undefined
  readonly type: FlagType
}

type FlagType =
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

interface ArgumentDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
  readonly variadic: boolean
  readonly type: ArgumentType
}

type ArgumentType =
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }
```

Extraction walks `config.flags` and `config.arguments` from each command's
`ConfigInternal`, uses `Param.extractSingleParams` to flatten nested param
structures, and reads `primitiveType._tag`, `typeName`, `description`, and
`aliases` from each `Single` param. For `Choice` primitives, the available
values are extracted. The function recurses into `subcommands`.

### 2. Shell generators

Each generator is a pure function:
`(executableName: string, descriptor: CommandDescriptor) => string`

All three generators share common patterns:

- Recursively walk the `CommandDescriptor` tree
- For each command, emit completions for its flags, arguments, and subcommands
- Use shell-native file/directory completion builtins where appropriate

#### 2.1 Bash generator

Produces a Bash completion script using the `complete` builtin and
`_init_completion` from bash-completion. Key features:

- One function per command path (e.g. `_myapp`, `_myapp_deploy`,
  `_myapp_deploy_staging`)
- Uses `compgen -W` for subcommand and flag name completion
- Uses `compgen -f` / `compgen -d` for file/directory arguments
- Inlines choice values as word lists
- Handles `--flag=value` style completions
- Supports `--no-<flag>` for boolean flags
- **Used-flag filtering**: builds an associative array mapping each flag form
  to a group index. At completion time, scans `COMP_WORDS` and removes the
  entire alias group (`--flag`, `-f`, `--no-flag`) once any form is used.

#### 2.2 Zsh generator

Produces a Zsh completion script using `_arguments` and `_describe`. Key
features:

- Uses `_arguments` specs for flags with descriptions
- Uses `_describe` for subcommand listing
- Uses `_files` and `_directories` for path arguments
- Inlines choice values with `(value1 value2 ...)` syntax
- Groups completions by type (options, commands, arguments)
- Supports `--no-<flag>` for boolean flags
- **Exclusion groups**: every flag spec includes a parenthesized exclusion
  list of all its forms (`--flag`, `-f`, `--no-flag`). Uses zsh brace
  expansion `'{-f,--flag}'` for short/long alias pairs. Once any form is
  used, `_arguments` suppresses all other forms in the group.

#### 2.3 Fish generator

Produces Fish completion commands using `complete -c`. Key features:

- One `complete` command per flag/subcommand/argument combination
- Uses `-l` for long flags, `-s` for short flags
- Uses `-r -f -a` for choice values
- Uses `-r -F` for file arguments
- Uses `-n` conditions based on the current subcommand path
- Supports `--no-<flag>` for boolean flags
- **Dedup via `__fish_contains_opt`**: every flag completion entry includes a
  `-n` condition that checks `not __fish_contains_opt` for all forms in its
  alias group. Combined with the subcommand condition using `; and`.

### 3. Integration with Command.run

The existing flow in `Command.ts` `runWith`:

```ts
if (completions !== undefined) {
  yield * Console.log(generateDynamicCompletion(command.name, completions))
  return
}
```

Changes to:

```ts
if (completions !== undefined) {
  const descriptor = CommandDescriptor.fromCommand(command)
  const script = Completions.generate(command.name, completions, descriptor)
  yield * Console.log(script)
  return
}
```

The `--get-completions` flag, `isCompletionRequest` check, and
`handleCompletionRequest` call are removed entirely.

---

## Implementation plan

### Phase 1: CommandDescriptor extraction ✅

**Files:**

- `packages/effect/src/unstable/cli/internal/completions/CommandDescriptor.ts` (created)
- `packages/effect/src/unstable/cli/Primitive.ts` (modified — `choice` now exposes `choiceKeys`, added `getChoiceKeys` helper)

**Work:** (all done)

1. Defined `CommandDescriptor`, `FlagDescriptor`, `ArgumentDescriptor`,
   `FlagType`, and `ArgumentType` interfaces.
2. Implemented `fromCommand(cmd: Command.Any): CommandDescriptor` that:
   - Reads `toImpl(cmd).config.flags` and `toImpl(cmd).config.arguments`
   - Calls `Param.extractSingleParams` on each param
   - Maps `Single.primitiveType._tag` to the appropriate type discriminant
   - Extracts choice values from `Choice` primitives via `Primitive.getChoiceKeys`
   - Extracts `typeName` for `Path` primitives
   - Reads `description`, `aliases`, and variadic/required metadata
   - Recurses into `cmd.subcommands`

### Phase 2: Shell generators ✅

**Files:**

- `packages/effect/src/unstable/cli/internal/completions/bash.ts` (rewritten)
- `packages/effect/src/unstable/cli/internal/completions/zsh.ts` (rewritten)
- `packages/effect/src/unstable/cli/internal/completions/fish.ts` (rewritten)

**Work:** (all done)

1. Each file exports a single `generate` function:
   `(executableName: string, descriptor: CommandDescriptor) => string`
2. Implemented recursive descent over the descriptor tree.
3. Emit shell-specific completion directives for each command node.
4. Handle all flag types, argument types, aliases, descriptions, and boolean
   negation.

**Bash generator:** Uses `complete` builtin with `_init_completion`. Generates
one function per command path, `compgen -W` for subcommands/flags, `compgen -f`/
`compgen -d` for file/directory arguments, inlines choice values, supports
`--no-<flag>` for booleans, dispatches to subcommand functions.

**Zsh generator:** Uses `_arguments` specs for flags with descriptions,
`_describe` for subcommand listing, `_files`/`_directories` for path arguments,
inlines choice values with `(val1 val2)` syntax, generates handler functions for
nested subcommands.

**Fish generator:** Emits `complete -c` commands per flag/subcommand, uses `-l`
for long flags and `-s` for short flags, `-r -f -a` for choice values, `-r -F`
for file arguments, `-n` conditions based on `__fish_use_subcommand` and
`__fish_seen_subcommand_from` for nested paths.

### Phase 3: Top-level Completions module ✅

**Files:**

- `packages/effect/src/unstable/cli/internal/completions/Completions.ts` (created)

**Work:** (all done)

1. Exported `generate(executableName: string, shell: Shell, descriptor: CommandDescriptor): string`
   that dispatches to the appropriate shell generator.
2. Defined `Shell` type inline (inlined from `types.ts`).

### Phase 4: Integration and cleanup ✅

**Files:**

- `packages/effect/src/unstable/cli/Command.ts` (modified)

**Work:** (all done)

1. Replaced `generateDynamicCompletion` and `isCompletionRequest` imports with
   `CommandDescriptor` and `Completions` imports.
2. Updated the `completions` branch in `runWith` to extract a `CommandDescriptor`
   and call `Completions.generate`.
3. Removed `isCompletionRequest` check and `handleCompletionRequest` call from
   `runWith`.
4. Deleted `packages/effect/src/unstable/cli/internal/completions/dynamic/`
   directory (all 5 files).
5. Deleted `packages/effect/src/unstable/cli/internal/completions/shared.ts`.
6. Deleted `packages/effect/src/unstable/cli/internal/completions/types.ts`
   (Shell type inlined in `Completions.ts`).
7. Deleted old `packages/effect/test/unstable/cli/completions/dynamic.test.ts`.

### Phase 5: Tests ✅

**Files:**

- `packages/effect/test/unstable/cli/completions/CommandDescriptor.test.ts` (created)
- `packages/effect/test/unstable/cli/completions/completions.test.ts` (created)

**Work:** (all done)

1. Created `CommandDescriptor.test.ts` with 17 tests covering:
   - Command name/description extraction
   - String, boolean, integer, float, file, directory, path, choice flag extraction
   - Flag aliases, descriptions, optional flags
   - Positional arguments with types, variadic, optional
   - Nested subcommands (recursive), deeply nested trees
   - Choice and file/directory arguments
   - Empty commands, multiple subcommands
2. Created `completions.test.ts` with 41 tests covering:
   - Bash: function generation, subcommands, flags (long/short/negation), compgen
     for files/directories, choice values, nested functions, markers
   - Zsh: _arguments specs, flag descriptions, _describe for subcommands,
     negation, _files/_directories, choice syntax, handlers, argument specs,
     #compdef directive, markers
   - Fish: complete commands, -l/-s flags, negation, -r -F for files,
     -r -f -a for choices, -n conditions, descriptions, nested paths, markers
   - Completions dispatcher: bash/zsh/fish routing
   - Integration: full ComprehensiveCli fixture through all 3 generators

---

## Testing

### Test structure

Tests use `@effect/vitest` with `it.effect` and `assert`. No `expect`. No
`process.env` mutation. All tests are pure functions over data.

### CommandDescriptor extraction tests

`packages/effect/test/unstable/cli/completions/CommandDescriptor.test.ts`

```ts
describe("CommandDescriptor", () => {
  describe("fromCommand", () => {
    it.effect("extracts command name and description")
    it.effect("extracts string flags with aliases")
    it.effect("extracts boolean flags")
    it.effect("extracts integer and float flags")
    it.effect("extracts file, directory, and path flags")
    it.effect("extracts choice flags with values")
    it.effect("extracts optional flags")
    it.effect("extracts positional arguments with types")
    it.effect("extracts variadic arguments")
    it.effect("extracts optional arguments")
    it.effect("extracts nested subcommands recursively")
    it.effect("extracts descriptions from flags and arguments")
    it.effect("handles commands with no flags or arguments")
    it.effect("handles deeply nested command trees")
  })
})
```

### Shell generator tests

`packages/effect/test/unstable/cli/completions/completions.test.ts`

Tests are structured identically for each shell. Each test builds a
`CommandDescriptor` (or uses `CommandDescriptor.fromCommand` on a test command),
generates the completion script, and asserts on the output string.

```ts
describe("Bash completions", () => {
  it.effect("generates completion function for root command")
  it.effect("includes subcommand names in word list")
  it.effect("includes long flag names with -- prefix")
  it.effect("includes short flag aliases")
  it.effect("generates --no-<flag> for boolean flags")
  it.effect("uses compgen -f for file-type flags")
  it.effect("uses compgen -d for directory-type flags")
  it.effect("inlines choice values for choice flags")
  it.effect("generates separate functions for nested subcommands")
  it.effect("includes descriptions as comments")
  it.effect("handles flag=value completion")
  it.effect("handles commands with no subcommands")
  it.effect("escapes special characters in descriptions")
})

describe("Zsh completions", () => {
  it.effect("generates _arguments specs for flags")
  it.effect("includes flag descriptions in specs")
  it.effect("includes subcommand descriptions with _describe")
  it.effect("generates --no-<flag> for boolean flags")
  it.effect("uses _files for file-type flags")
  it.effect("uses _directories for directory-type flags")
  it.effect("inlines choice values with (val1 val2) syntax")
  it.effect("generates handler functions for nested subcommands")
  it.effect("generates argument specs for positional arguments")
  it.effect("handles variadic arguments")
  it.effect("escapes colons and backslashes in descriptions")
})

describe("Fish completions", () => {
  it.effect("generates complete commands for root subcommands")
  it.effect("generates complete commands for flags with -l and -s")
  it.effect("generates --no-<flag> for boolean flags")
  it.effect("uses -r -F for file-type flags")
  it.effect("uses -r -f -a for choice flags")
  it.effect("uses -n conditions for nested subcommand flags")
  it.effect("includes descriptions with -d flag")
  it.effect("handles deeply nested command paths")
  it.effect("handles commands with no flags")
})
```

### Integration test

A single integration test uses the `ComprehensiveCli` fixture:

```ts
describe("Completions integration", () => {
  it.effect("generates valid bash script for ComprehensiveCli")
  it.effect("generates valid zsh script for ComprehensiveCli")
  it.effect("generates valid fish script for ComprehensiveCli")
})
```

These tests call `CommandDescriptor.fromCommand(ComprehensiveCli)`, generate
scripts for each shell, and assert that key subcommands, flags, and descriptions
appear in the output. They serve as smoke tests to ensure the full pipeline
works end-to-end.

---

## Files to modify

| File                                                                         | Change                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/effect/src/unstable/cli/internal/completions/CommandDescriptor.ts` | **New.** Descriptor types and `fromCommand` extractor                            |
| `packages/effect/src/unstable/cli/internal/completions/Completions.ts`       | **New.** Top-level `generate` dispatcher                                         |
| `packages/effect/src/unstable/cli/internal/completions/bash.ts`              | **Rewrite.** Static Bash completion generator                                    |
| `packages/effect/src/unstable/cli/internal/completions/zsh.ts`               | **Rewrite.** Static Zsh completion generator                                     |
| `packages/effect/src/unstable/cli/internal/completions/fish.ts`              | **Rewrite.** Static Fish completion generator                                    |
| `packages/effect/src/unstable/cli/internal/completions/types.ts`             | **Keep/update.** `Shell` type, remove `FlagDescriptor` and `optionRequiresValue` |
| `packages/effect/src/unstable/cli/Command.ts`                                | **Modify.** Replace dynamic completion imports and logic with static generation  |
| `packages/effect/src/unstable/cli/internal/completions/dynamic/core.ts`      | **Delete.**                                                                      |
| `packages/effect/src/unstable/cli/internal/completions/dynamic/handler.ts`   | **Delete.**                                                                      |
| `packages/effect/src/unstable/cli/internal/completions/dynamic/bash.ts`      | **Delete.**                                                                      |
| `packages/effect/src/unstable/cli/internal/completions/dynamic/zsh.ts`       | **Delete.**                                                                      |
| `packages/effect/src/unstable/cli/internal/completions/dynamic/fish.ts`      | **Delete.**                                                                      |
| `packages/effect/src/unstable/cli/internal/completions/shared.ts`            | **Delete.**                                                                      |
| `packages/effect/test/unstable/cli/completions/CommandDescriptor.test.ts`    | **New.** Descriptor extraction tests                                             |
| `packages/effect/test/unstable/cli/completions/completions.test.ts`          | **Rewrite.** Shell generator and integration tests                               |
| `packages/effect/test/unstable/cli/completions/dynamic.test.ts`              | **Delete.**                                                                      |

## Validation

- `pnpm lint-fix`
- `pnpm vitest packages/effect/test/unstable/cli/completions/`
- `pnpm check` (run `pnpm clean` first if needed)
- `pnpm build`

## Acceptance criteria

- `--completions bash|zsh|fish` produces a self-contained completion script that
  does not re-invoke the CLI binary.
- All subcommands, flags (long and short), boolean negation, choice values,
  file/directory hints, and positional arguments are represented in each shell's
  script.
- The dynamic completion system (`--get-completions`, `COMP_*` env vars,
  `handleCompletionRequest`) is fully removed.
- All tests pass without mutating `process.env` or `process.argv`.
- Code uses idiomatic Effect patterns throughout.

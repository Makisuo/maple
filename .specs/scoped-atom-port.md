# ScopedAtom module port for @effect/atom-react

## Summary

Port the `ScopedAtom` module from the legacy `@effect-atom/atom-react` package into
`@effect/atom-react`, matching its API and behavior while updating package naming
and adding documentation and tests.

## Background

The Effect repository already includes `@effect/atom-react` with hooks and the
`RegistryProvider`, but it lacks the `ScopedAtom` module that existed in the old
atom-react package. `ScopedAtom` provides a simple way to create an Atom scoped
to a React provider so each provider instance owns its own Atom instance. This
port restores parity for consumers who relied on that module.

## Legacy Reference

- Source module: `.repos/effect-atom-old/packages/atom-react/src/ScopedAtom.ts`
- Legacy docs: `.repos/effect-atom-old/docs/atom-react/ScopedAtom.ts.md`

## Goals

- Provide a `ScopedAtom` module with the same surface area as the legacy version.
- Update identifiers to the `@effect/atom-react` package namespace.
- Ensure behavior matches the old module (context-based scoping, error on misuse).
- Expose the module through the `@effect/atom-react` public API.
- Add documentation and tests covering the module.

## Non-goals

- No changes to `Atom`, `AtomRegistry`, or existing hooks.
- No redesign or new features beyond the legacy module behavior.
- No cross-package API changes outside `@effect/atom-react`.

## Requirements

### Module API

- Add `packages/atom/react/src/ScopedAtom.ts` with `"use client"` directive as
  the first executable statement in the module.
- Use `effect/unstable/reactivity/Atom` for Atom types and `react` for context.
- Export:
  - `TypeId` type alias as `"~@effect/atom-react/ScopedAtom"`.
  - `TypeId` constant with the same string literal.
  - `ScopedAtom` interface:
    - `[TypeId]: TypeId` tag.
    - `use(): A` hook accessor.
    - `Provider` component (conditional on `Input`):
      - `Input extends never`: `{ children? }`.
      - Otherwise: `{ children?, value: Input }`.
    - `Context: React.Context<A>`.
  - `make` constructor:
    - Signature: `<A extends Atom.Atom<any>, Input = never>(f: (() => A) | ((input: Input) => A)) => ScopedAtom<A, Input>`.
    - Creates a React context with `undefined` as the sentinel placeholder value.
    - `use()` reads from context and throws when used outside provider
      (strict `undefined` check).
    - `Provider` creates the Atom once via `useRef`, using `value` when provided.
    - Returns `{ [TypeId], use, Provider, Context }`.

### Behavior

- `use()` throws `Error("ScopedAtom used outside of its Provider")` when the
  hook is called without a matching provider (detected by `undefined`).
- Each `Provider` instance owns a single Atom instance across re-renders.
- Separate Providers create isolated Atom instances.
- When `Input` is provided, the constructor receives the `value` prop only on
  first render, and the prop is required for non-`never` inputs.

### Exports

- Expose `ScopedAtom` from the package barrel (`packages/atom/react/src/index.ts`)
  via `pnpm codegen` (do not edit barrels manually).
- Ensure `@effect/atom-react/ScopedAtom` resolves via package exports.

### Documentation

- Add JSDoc headers with `@since 1.0.0` and category tags matching existing
  `atom-react` modules (`Type IDs`, `models`, `constructors`).
- Ensure `pnpm docgen` picks up the new module in docs.

### Testing

- Add tests under `packages/atom/react/test`, preferably in
  `ScopedAtom.test.tsx`, using existing React Testing Library patterns.
- Test coverage includes:
  - `use()` throws when used outside the Provider.
  - Provider scopes Atom instances (two providers yield different Atoms).
  - Input-based factory receives the `value` and is only called once per
    Provider.
  - Integration with `useAtomValue` (or equivalent hook) works with scoped
    atoms.

## Validation

- `pnpm codegen`
- `pnpm lint-fix`
- `pnpm test packages/atom/react/test/<relevant test file>`
- `pnpm check` (run `pnpm clean` then re-run if it fails)
- `pnpm build`
- `pnpm docgen`

## Acceptance Criteria

- `packages/atom/react/src/ScopedAtom.ts` matches legacy API and behavior with
  updated package naming.
- Module is exported via `@effect/atom-react` barrel and package exports.
- Documentation includes the new module and its API.
- Tests cover the provider scoping behavior and error handling.
- All validation steps pass.

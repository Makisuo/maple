# @effect/atom-solid bindings

## Summary

Add a new `@effect/atom-solid` package that provides SolidJS bindings for the Effect Atom modules, mirroring the `@effect/atom-react` feature set and behavior (except `ScopedAtom`) while adopting Solid naming conventions.

## Background

The repository currently ships `@effect/atom-react` with React hooks and a registry provider, but there is no SolidJS equivalent. Solid users need a first-party package that integrates `effect/unstable/reactivity` atoms with Solid reactivity and Suspense, with a compatible API surface.

## Goals

- Provide a SolidJS package at `packages/atom/solid` exporting `@effect/atom-solid`.
- Match the `@effect/atom-react` behavior for Atom reading, writing, subscriptions, and AsyncResult handling.
- Use Solid naming (`create*`) instead of React hook names.
- Deliver docs and tests mirroring the React package (excluding SSR and ScopedAtom).

## Non-goals

- Implementing `ScopedAtom` in Solid.
- Adding SSR-specific behavior or server snapshot semantics.
- Changing `effect/unstable/reactivity` Atom/AtomRegistry behavior.

## Requirements

### Package layout

- New package directory: `packages/atom/solid`.
- Package name: `@effect/atom-solid`.
- Provide `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `docgen.json`, `vitest.config.ts`, and `vitest.setup.ts`, mirroring the structure of `packages/atom/react` with Solid-specific dependencies.
- Exports map should include `.` and `./*` entries for `src/*.ts`, and publish config for `dist` outputs.
- Ensure repo tooling includes the new package where required (tsconfig references, docgen discovery, workspace filters) so `codegen`, `build`, and `docgen` pick it up.

### Dependencies

- `solid-js` as a peer dependency (Solid 1.x).
- Testing peer/dev dependencies for Solid testing (`@solidjs/testing-library`, `jsdom`), aligned with how `@effect/atom-react` declares testing peers.
- `effect` as a workspace dependency.

### Public API (Solid naming)

Mirror the React bindings (except `ScopedAtom`) with Solid-style names:

- `createAtomInitialValues` (from `useAtomInitialValues`).
- `createAtomValue` (from `useAtomValue`).
- `createAtomMount` (from `useAtomMount`).
- `createAtomSet` (from `useAtomSet`).
- `createAtomRefresh` (from `useAtomRefresh`).
- `createAtom` (from `useAtom`).
- `createAtomSuspense` (from `useAtomSuspense`).
- `createAtomSubscribe` (from `useAtomSubscribe`).
- `createAtomRef`, `createAtomRefProp`, `createAtomRefPropValue` (from `useAtomRef*`).
- `RegistryContext`, `RegistryProvider`.

Naming is Solid-first (no `use*` aliases) while keeping signatures and behavior equivalent to React where feasible.

### Registry context and provider

- Provide `RegistryContext` created via `solid-js` `createContext`, defaulting to `AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 })`.
- Implement `scheduleTask` for Solid using a cancellable scheduler (e.g. `setTimeout(0)` returning a disposer).
- `RegistryProvider` creates a registry once per provider instance, keeps it stable across reactive updates, and disposes it on cleanup.
- Support provider options:
  - `initialValues?: Iterable<[Atom.Atom<any>, any]>`
  - `scheduleTask?: (f: () => void) => () => void`
  - `timeoutResolution?: number`
  - `defaultIdleTTL?: number`

### Hook semantics (Solid equivalents)

- `createAtomValue(atom, map?)` returns a Solid `Accessor` that tracks the Atom in the current registry; `map` creates a derived Atom once and tracks it.
- `createAtomInitialValues` sets initial values once per registry/Atom pair (same WeakSet semantics as React).
- `createAtomMount` ensures the Atom is mounted while the calling owner is alive.
- `createAtomSet` returns a setter; when `mode` is `promise` or `promiseExit` for AsyncResult atoms, it returns an async setter matching React behavior.
- `createAtomRefresh` returns a function that refreshes the Atom.
- `createAtom` returns `[Accessor<R>, write]` matching `createAtomValue` + `createAtomSet`.
- `createAtomSubscribe` subscribes to Atom changes and cleans up on owner disposal.
- `createAtomRef` returns an `Accessor` that tracks a `AtomRef` value via subscription.
- `createAtomRefProp` and `createAtomRefPropValue` mirror the React helpers but in Solid accessor form.

### Suspense behavior

- `createAtomSuspense` supports the same `suspendOnWaiting` and `includeFailure` options as React.
- It should integrate with Solid Suspense (client-side only) by throwing a Promise while the Atom is `Initial` (and optionally `waiting`), and exposing the resolved value once ready.
- When `includeFailure` is false, failures are surfaced as thrown errors (to be handled by Solid error boundaries).

### Documentation

- `packages/atom/solid/README.md` mirrors the React package with an API docs link: `https://effect-ts.github.io/effect/docs/atom-solid`.
- `docgen.json` configured similarly to the React package, with correct `srcLink` for `packages/atom/solid/src/`.
- JSDoc headers with `@since 1.0.0` and categories consistent with atom-react modules.

### Testing

- Add a Solid test suite under `packages/atom/solid/test` using `@solidjs/testing-library`.
- Mirror key React tests where relevant:
  - Reading values from basic and computed Atoms.
  - Updating values when registry sets an Atom.
  - `createAtom` setter semantics (including functional update form).
  - AsyncResult + `createAtomSuspense` success/failure behaviors.
  - `createAtomInitialValues` only applies once.
  - `createAtomRef` and `createAtomRefPropValue` updates.
- Exclude SSR-specific tests and ScopedAtom tests.

## Implementation plan

1. Scaffold `packages/atom/solid` with baseline files (`package.json`, `README.md`, `LICENSE`, `tsconfig.json`, `docgen.json`, `vitest.config.ts`, `vitest.setup.ts`, `src` folder) and minimal exports so the package builds in isolation.
2. Implement `RegistryContext` and `RegistryProvider` in `packages/atom/solid/src/RegistryContext.ts` using Solid context and lifecycle primitives, including configurable `scheduleTask` and cleanup disposal.
3. Implement core hooks in `packages/atom/solid/src/Hooks.ts` for value access, mount, set, refresh, and subscribe (no AtomRef helpers yet); return Solid accessors/setters as specified.
4. Add tests for core hooks in `packages/atom/solid/test/index.test.tsx` (basic value, computed, updates, createAtom setter behavior, createAtomInitialValues).
5. Implement AtomRef helpers (`createAtomRef`, `createAtomRefProp`, `createAtomRefPropValue`) in `packages/atom/solid/src/Hooks.ts`.
6. Add tests covering AtomRef helpers.
7. Implement `createAtomSuspense` for AsyncResult atoms with Solid Suspense integration and error propagation rules.
8. Add AsyncResult/suspense tests (success and failure) in the Solid test suite.
9. Add module exports and run `pnpm codegen` to generate the barrel `packages/atom/solid/src/index.ts` (do not hand-edit).
10. Add or update package documentation (`README.md`, `docgen.json`) and update `.specs/README.md` with a link to this spec.

## Validation

- `pnpm codegen`
- `pnpm lint-fix`
- `pnpm test packages/atom/solid/test/index.test.tsx`
- `pnpm check` (run `pnpm clean` and re-run if it fails)
- `pnpm build`
- `pnpm docgen`

## Acceptance criteria

- `@effect/atom-solid` package exists under `packages/atom/solid` and builds via repository scripts.
- Public API matches the specified Solid naming and behavior, excluding `ScopedAtom` and SSR.
- Solid tests cover the core Atom interactions and AsyncResult suspense behaviors.
- Documentation is published via docgen and the spec is listed in `.specs/README.md`.
- All validation steps pass.

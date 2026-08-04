# @maple/unitflow

Vendored copy of [unitflow](https://github.com/timurrakhimzhan/unitflow) (`@unitflow/core` + `@unitflow/react`), ported to the workspace's effect version.

- **Upstream commit:** `51729b480fd84ed64a121bf2180eae3c45a7c5c2` (2026-07-06)
- **Upstream license:** MIT (declared in each upstream `package.json`; upstream ships no standalone LICENSE file)
- **Ported from:** effect `4.0.0-beta.88` → workspace catalog pin (`catalog:effect`, currently `4.0.0-beta.93`)

## Why vendored

Upstream exact-pins `effect@4.0.0-beta.88` as a peer; this workspace pins a bun-patched `4.0.0-beta.93`. Effect v4 betas break between releases, so the package is vendored and ported rather than depended on. When bumping the effect catalog, re-typecheck and re-test this package as part of the upgrade procedure.

## Layout

- `src/core/` — upstream `packages/core/src` (Store, Event, Query, Mutation, Model, Registry, runtime)
- `src/react/` — upstream `packages/react/src` (`Unitflow` root, `View.make`, hooks); `@unitflow/core` imports rewritten to relative paths
- `src/db/` — **Maple addition**: TanStack DB adapter (`fromCollection`, `liveQueryStore`, `scopedByKey`) — not upstream
- `test/` — upstream `packages/core/test` (`../src/*.js` imports rewritten to `../src/core/*.js`)

`Symbol.for("@unitflow/core/...")` identity keys are kept as-is to minimize diff against upstream.

## Syncing with upstream

Diff against the recorded commit, re-apply the import rewrites above, port any new effect API usage, run `vitest run` + `tsc --noEmit`.

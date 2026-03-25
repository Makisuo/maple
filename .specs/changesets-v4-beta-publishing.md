# Changesets v4 Beta Publishing

## Summary

Publish all 24 public Effect packages under unified `4.0.0-beta.<n>` pre-release
versions using changesets' `fixed` groups and pre-release mode.

## Background

Effect v4 is a major rewrite. All public packages must move in lockstep under a
single version number (`4.0.0-beta.0`, `4.0.0-beta.1`, ...) so consumers can
install a coherent set of packages at any beta iteration. Changesets supports
this via **fixed version groups** (all packages in a group share the same
version) combined with **pre-release mode** (versions are suffixed with
`-beta.<n>`).

## Goals

- All 24 public packages publish the same `4.0.0-beta.<n>` version on every release.
- Developers continue using the standard `pnpm changeset` workflow.
- The `beta` dist-tag is used on npm so `latest` remains on the stable v3 line.
- Graduating to stable `4.0.0` is a single command (`npx changeset pre exit`).

## Non-goals

- No changes to the build system, CI pipeline scripts, or package contents.
- No independent versioning — all packages move together.
- No canary/nightly publishing strategy.

## How it works

### Fixed groups

The `fixed` field in `.changeset/config.json` takes an array of package-name
arrays. All packages in a group are bumped to the **same version** whenever any
one of them is included in a changeset. By placing all 24 public packages in one
group, a single changeset touching any package triggers a version bump for every
package.

### Pre-release mode

Running `npx changeset pre enter beta` creates `.changeset/pre.json` with
`"mode": "pre"` and `"tag": "beta"`. While active:

- `npx changeset version` appends `-beta.<n>` to computed versions.
- `npx changeset publish` pushes to the `beta` dist-tag on npm (not `latest`).
- The counter `<n>` increments automatically on each `version` run.

### Version stability during pre-release

A common concern: won't a `minor` or `patch` changeset during the beta change
the base version (e.g., `4.0.0-beta.1` → `4.1.0-beta.0`)? No — changesets
prevents this via `pre.json`.

`pre.json` stores two critical fields:

- **`initialVersions`**: the version of each package when pre-release mode was
  entered (e.g., `3.0.0`).
- **`changesets`**: the IDs of every changeset applied since entering
  pre-release mode.

When `changeset version` runs, it computes the target version relative to
`initialVersions` using the **cumulative** bump of all tracked changesets (both
already-applied ones in `pre.json.changesets` and new pending ones). Because the
initial major changeset is always in the tracked set, the highest bump type is
always `major`, and the base version stays at `4.0.0` regardless of subsequent
patch or minor changesets. Only the beta counter increments.

Example:

1. Enter pre-release, `initialVersions` = `3.0.0`
2. Major changeset → `changeset version` → `4.0.0-beta.0` (major from `3.0.0`)
3. Developer adds a patch changeset → `changeset version` → `4.0.0-beta.1`
   (major still highest → base unchanged, counter increments)
4. Developer adds a minor changeset → `changeset version` → `4.0.0-beta.2`
   (major still highest → base unchanged, counter increments)

The base semver never drifts during the beta period.

### Combined behavior

With both features active, every `changeset version` + `changeset publish` cycle
produces a release where all 24 packages share `4.0.0-beta.<n>`.

## Setup steps

### 1. Align all package versions to `3.0.0`

Before entering pre-release mode, set every public package's `version` field to
`3.0.0` so the subsequent major bump lands on `4.0.0-beta.0`.

Packages to update (24 total):

| Package                           | Current version |
| --------------------------------- | --------------- |
| `effect`                          | `4.0.0`         |
| `@effect/ai-anthropic`            | `0.1.0`         |
| `@effect/ai-openai`               | `0.1.0`         |
| `@effect/atom-react`              | `0.0.0`         |
| `@effect/atom-solid`              | `0.0.0`         |
| `@effect/atom-vue`                | `0.38.1`        |
| `@effect/opentelemetry`           | `0.60.0`        |
| `@effect/platform-browser`        | `0.72.0`        |
| `@effect/platform-bun`            | `0.61.6`        |
| `@effect/platform-node`           | `0.77.6`        |
| `@effect/platform-node-shared`    | `0.31.6`        |
| `@effect/sql-clickhouse`          | `0.38.1`        |
| `@effect/sql-d1`                  | `0.42.1`        |
| `@effect/sql-libsql`              | `0.34.1`        |
| `@effect/sql-mssql`               | `0.45.1`        |
| `@effect/sql-mysql2`              | `0.45.1`        |
| `@effect/sql-pg`                  | `0.45.1`        |
| `@effect/sql-sqlite-bun`          | `0.45.1`        |
| `@effect/sql-sqlite-do`           | `0.22.1`        |
| `@effect/sql-sqlite-node`         | `0.45.1`        |
| `@effect/sql-sqlite-react-native` | `0.47.1`        |
| `@effect/sql-sqlite-wasm`         | `0.45.1`        |
| `@effect/openapi-generator`       | `0.4.13`        |
| `@effect/vitest`                  | `0.21.1`        |

### 2. Update `.changeset/config.json`

Add the `fixed` group and change `access` to `"public"`:

```jsonc
{
  "$schema": "https://unpkg.com/@changesets/config@1.6.4/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "Effect-TS/effect" }],
  "commit": false,
  "linked": [],
  "fixed": [
    [
      "effect",
      "@effect/ai-anthropic",
      "@effect/ai-openai",
      "@effect/atom-react",
      "@effect/atom-solid",
      "@effect/atom-vue",
      "@effect/opentelemetry",
      "@effect/openapi-generator",
      "@effect/platform-browser",
      "@effect/platform-bun",
      "@effect/platform-node",
      "@effect/platform-node-shared",
      "@effect/sql-clickhouse",
      "@effect/sql-d1",
      "@effect/sql-libsql",
      "@effect/sql-mssql",
      "@effect/sql-mysql2",
      "@effect/sql-pg",
      "@effect/sql-sqlite-bun",
      "@effect/sql-sqlite-do",
      "@effect/sql-sqlite-node",
      "@effect/sql-sqlite-react-native",
      "@effect/sql-sqlite-wasm",
      "@effect/vitest",
    ],
  ],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["scratchpad"],
  "snapshot": {
    "useCalculatedVersion": false,
    "prereleaseTemplate": "{tag}-{commit}",
  },
}
```

### 3. Enter pre-release mode

```bash
npx changeset pre enter beta
```

This creates/updates `.changeset/pre.json` with `"mode": "pre"` and
`"tag": "beta"`. The `initialVersions` map records `3.0.0` for every package.

### 4. Create the initial major changeset

```bash
npx changeset
```

Select **all 24 packages**, choose **major** bump, and provide a summary like
"Effect v4 beta". This ensures the first `changeset version` run produces
`4.0.0-beta.0` across the board.

### 5. Run version and publish

```bash
npx changeset version   # sets all packages to 4.0.0-beta.0
npx changeset publish   # publishes to npm under the "beta" dist-tag
```

## Ongoing workflow

### Adding changesets

Developers continue using `pnpm changeset` as usual. Because of the `fixed`
group, the bump type (patch/minor/major) of any individual changeset is
effectively irrelevant to the version number — all packages are already on a
major bump track. However, the changeset message still serves as the changelog
entry, so meaningful descriptions are important.

### Publishing a new beta

```bash
npx changeset version   # bumps to 4.0.0-beta.(n+1)
npx changeset publish   # publishes all packages under "beta" tag
```

The counter auto-increments. No manual version editing is needed.

### CI integration

The existing CI publish workflow (typically `changeset version` +
`changeset publish` in a GitHub Action) works without modification. The
pre-release mode and fixed group are configuration-only — no script changes
required.

## Graduating to stable

When ready to release `4.0.0`:

```bash
npx changeset pre exit   # removes pre-release mode
npx changeset version    # sets all packages to 4.0.0
npx changeset publish    # publishes to "latest" dist-tag
```

After exiting, the `fixed` group can remain to keep packages in lockstep for
future `4.x` releases, or be removed if independent versioning is desired.

## Edge cases

### Workspace dependency ranges

`updateInternalDependencies: "patch"` ensures workspace `dependencies` and
`peerDependencies` are updated whenever a dependency's version changes. Because
all packages share the same version, cross-references will always point to the
current beta. Verify that dependency ranges use `workspace:^` (pnpm protocol) so
they resolve correctly during development and are rewritten to concrete ranges on
publish.

### Existing patches on the v3 line

If the v3 stable line needs a hotfix while the beta is active, it should be done
on a separate branch that does **not** have the `fixed` group or pre-release
mode. The `main` branch is exclusively for v4 beta.

### npm version collision safety

Changesets' pre-release counter prevents collisions — `4.0.0-beta.0`,
`4.0.0-beta.1`, etc. are distinct versions. npm's immutability guarantees that a
published version can never be overwritten.

### Private packages

The four private packages (`@effect/ai-codegen`, `@effect/bundle`, `@effect/oxc`,
`@effect/utils`) are excluded from the `fixed` group and are never published.
The `scratchpad` and `scripts` workspace packages remain in `ignore`.

### Packages at version `0.0.0`

`@effect/atom-react` and `@effect/atom-solid` are currently at `0.0.0`. These
must be aligned to `3.0.0` along with all other packages before entering
pre-release mode. A `0.x` → `4.0.0-beta.0` jump via major bump is technically
valid but the `fixed` group requires all members to share the same version, so
alignment is mandatory.

## Files to modify

| File                                            | Change                                        |
| ----------------------------------------------- | --------------------------------------------- |
| `.changeset/config.json`                        | Add `fixed` array, set `access` to `"public"` |
| `.changeset/pre.json`                           | Created/updated by `changeset pre enter beta` |
| `packages/effect/package.json`                  | Set `version` to `3.0.0`                      |
| `packages/ai/anthropic/package.json`            | Set `version` to `3.0.0`                      |
| `packages/ai/openai/package.json`               | Set `version` to `3.0.0`                      |
| `packages/atom/react/package.json`              | Set `version` to `3.0.0`                      |
| `packages/atom/solid/package.json`              | Set `version` to `3.0.0`                      |
| `packages/atom/vue/package.json`                | Set `version` to `3.0.0`                      |
| `packages/opentelemetry/package.json`           | Set `version` to `3.0.0`                      |
| `packages/platform-browser/package.json`        | Set `version` to `3.0.0`                      |
| `packages/platform-bun/package.json`            | Set `version` to `3.0.0`                      |
| `packages/platform-node/package.json`           | Set `version` to `3.0.0`                      |
| `packages/platform-node-shared/package.json`    | Set `version` to `3.0.0`                      |
| `packages/sql/clickhouse/package.json`          | Set `version` to `3.0.0`                      |
| `packages/sql/d1/package.json`                  | Set `version` to `3.0.0`                      |
| `packages/sql/libsql/package.json`              | Set `version` to `3.0.0`                      |
| `packages/sql/mssql/package.json`               | Set `version` to `3.0.0`                      |
| `packages/sql/mysql2/package.json`              | Set `version` to `3.0.0`                      |
| `packages/sql/pg/package.json`                  | Set `version` to `3.0.0`                      |
| `packages/sql/sqlite-bun/package.json`          | Set `version` to `3.0.0`                      |
| `packages/sql/sqlite-do/package.json`           | Set `version` to `3.0.0`                      |
| `packages/sql/sqlite-node/package.json`         | Set `version` to `3.0.0`                      |
| `packages/sql/sqlite-react-native/package.json` | Set `version` to `3.0.0`                      |
| `packages/sql/sqlite-wasm/package.json`         | Set `version` to `3.0.0`                      |
| `packages/tools/openapi-generator/package.json` | Set `version` to `3.0.0`                      |
| `packages/vitest/package.json`                  | Set `version` to `3.0.0`                      |

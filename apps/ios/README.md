# Maple for iOS

A native SwiftUI client for Maple: Clerk sign-in, services, and error issues,
reading the **v2 public API**.

## Getting started

```bash
brew install xcodegen        # once
cd apps/ios && ./scripts/bootstrap.sh
```

That generates `Maple.xcodeproj` and opens it. On first run it also copies
`Config/Secrets.example.xcconfig` to `Config/Secrets.xcconfig` — put a Clerk
publishable key in there before running, or the app stops at launch with a
message telling you the same thing.

Which key depends on which API you point at:

| `MAPLE_API_BASE_URL`      | Clerk instance          | Key                                                    |
| ------------------------- | ----------------------- | ------------------------------------------------------ |
| `https://api.maple.dev`   | production, `clerk.maple.dev` | `PUBLIC_CLERK_PUBLISHABLE_KEY` from `.env.local` (`pk_live_…`) |
| `http://localhost:3472`   | dev                     | `CLERK_PUBLISHABLE_KEY` from `.env.local` (`pk_test_…`)       |

They are not interchangeable: the API verifies a token against its own Clerk
instance, so a `pk_test_` session against `api.maple.dev` is rejected.

Xcode will ask once to trust the swift-openapi-generator build-tool plugin.

## Layout

```
project.yml                  XcodeGen source of truth; Maple.xcodeproj is generated + gitignored
Config/                      xcconfigs; Secrets.xcconfig is gitignored
Maple/App                    entry point, auth gate, build-time config
Maple/Auth                   token provider, session state machine, org picker
Maple/DesignSystem           tokens, type scale, service colours, shared primitives
Maple/Features               services and issues screens
Maple/Components             LoadableView, formatting
Maple/Resources/Fonts        Geist + Geist Mono (SIL OFL)
Packages/MapleAPI            the generated API client — builds and tests with plain `swift test`
```

Everything that is worth unit-testing lives in `Packages/MapleAPI`, which has no
UIKit, no simulator, and no signing requirement. That is why CI runs
`swift test` there first: it fails in about a minute rather than after a full
app build.

## The API client is generated

`Packages/MapleAPI/Sources/MapleAPI/openapi.json` is **generated and committed**.
Regenerate it from the repo root after any change to the v2 contract:

```bash
bun run ios:openapi
```

`bun run ios:openapi:check` runs in CI's `quality` shard and fails if the two
drift.

The script (`scripts/generate-ios-openapi.ts`) does more than dump the spec. The
full v2 document is 94 paths and 480+ schemas, and Effect's JSON-Schema output
uses three idioms that generate unusable Swift:

| Contract emits | Without normalization | After |
| --- | --- | --- |
| `anyOf: [T, null]` | `Union_23` with `.value1: String?` | `String?` |
| `anyOf: [number, enum["NaN", …]]` | a struct wrapping a `Double` | `Double` |
| `allOf: [{minLength}, {pattern}]` | struct with `value1`/`value2` | `String` |

It also prunes to the five operations the app calls and collapses every error
response to a single `MapleErrorEnvelope`. Result: 21 schemas instead of 480.

Adding a screen means adding its `operationId` to `IOS_OPERATIONS` in that
script and re-running it. A removed or renamed operation makes the script exit
non-zero rather than silently shrinking the client.

## The organization constraint

The v2 API has **no organization header**. It reads the org from the Clerk
session token's active-organization claim, and rejects a token without one
(`"Active organization is required"`). Two consequences shape the app:

1. The tab bar exists only in `AuthPhase.ready`. Building it and hiding it would
   let its `.task` modifiers fire requests that 401.
2. Switching orgs means re-minting the token, not changing a header. After
   `setActive`, `ClerkTokenProvider.invalidate()` forces the next fetch past
   Clerk's own token cache, and `SessionController.dataGeneration` increments so
   every screen's `.task(id:)` cancels and reloads.

A 401 whose message mentions an active organization routes to the org picker,
not to sign-out — the user is still authenticated.

## Design system

`Maple/DesignSystem` ports the product's visual language rather than inventing a
native one — see `DESIGN.md` and `packages/ui/src/styles/tokens.css`.

- **`Tokens.swift`** holds the palette in OKLCH, the same numbers as the
  stylesheet, converted to sRGB at runtime so a token can be diffed against the
  CSS by eye. Light and dark both resolve from one declaration.
- **`Typography.swift`** — the defining choice is that **Geist Mono is the body
  font**, with proportional Geist reserved for page titles and empty states.
  That inversion does most of the identity work; don't undo it. The TTFs are
  instanced from the `@fontsource-variable` packages and shipped under
  `Maple/Resources/Fonts` with the SIL OFL licence.
- **`ServiceColor.swift`** reproduces `packages/ui/src/lib/colors.ts` bit for
  bit, including its 32-bit signed hash overflow, so a service is the same
  colour on the phone as in a browser tab.
- **`Primitives.swift`** carries the badge, health-dot, stat-tile, hairline, and
  detail-row patterns, plus the error-rate and latency tone thresholds from
  `latency-tone.ts` and `service-health.ts`.

Conventions worth keeping: hairline borders (never 2px), depth from tonal steps
rather than shadows, `tabularNumbers()` on every numeral, uppercase only for the
`SectionLabel` idiom, skeletons instead of spinners, and the amber primary at
most once per screen.

To change a colour, change it in `tokens.css` first and mirror it here.

## A note on Package.resolved

`Packages/MapleAPI/Package.resolved` is committed and holds every pin including
Clerk's, because `xcodebuild` resolves the app's dependencies through it. Running
`swift test` in the package alone rewrites it to just the package's own
dependencies. Both are valid; the committed superset is the reproducible one, so
don't commit the shrunken version if a `swift test` run leaves it dirty.

The durable Clerk pin is `exactVersion` in `project.yml` — the app-level resolved
file lives inside the generated `.xcodeproj`, which is gitignored.

## Testing

```bash
cd apps/ios/Packages/MapleAPI && swift test    # no simulator needed
cd apps/ios && xcodegen generate && xcodebuild build -scheme Maple \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

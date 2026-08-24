# Maple for iOS

A native SwiftUI client for Maple, reading the **v2 public API**. Three tabs,
in the order the questions get asked — see [`PRODUCT.md`](PRODUCT.md):

- **Home** — is anything wrong right now? Status headline, open alerts with
  the rule's own last hour, services needing attention, what's new in 24h.
- **Services** — the list, and a detail with golden-signal sparklines, scoped
  alerts, issues, and top failing/slowest operations.
- **Alerts** — the triage hub: incidents (with a "why" detail: what the rule
  saw, what changed on the service, likely cause, timeline), error issues,
  anomalies.

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

| `MAPLE_API_BASE_URL`    | Clerk instance                | Key                                                            |
| ----------------------- | ----------------------------- | -------------------------------------------------------------- |
| `https://api.maple.dev` | production, `clerk.maple.dev` | `PUBLIC_CLERK_PUBLISHABLE_KEY` from `.env.local` (`pk_live_…`) |
| `http://localhost:3472` | dev                           | `CLERK_PUBLISHABLE_KEY` from `.env.local` (`pk_test_…`)        |

They are not interchangeable: the API verifies a token against its own Clerk
instance, so a `pk_test_` session against `api.maple.dev` is rejected.

Xcode will ask once to trust the swift-openapi-generator build-tool plugin.

## Layout

```
project.yml                  XcodeGen source of truth; Maple.xcodeproj is generated + gitignored
Config/                      xcconfigs; Secrets.xcconfig is gitignored
Maple/App                    entry point, auth gate, build-time config, Route
Maple/Auth                   token provider, session state machine, org picker
Maple/DesignSystem           tokens, type scale, service colours, shared primitives
Maple/Features               Home, Services, Alerts (incidents/anomalies), Issues
Maple/Components             LoadableView, formatting, Sparkline, alert formatting
Maple/Fixtures               FixtureAPI — the app without Clerk or a network
Maple/Widgets                publishes the widget's snapshot; background refresh
Maple/Resources/Fonts        Geist + Geist Mono (SIL OFL)
Widgets/                     the Home Screen / Lock Screen widget extension
Packages/MapleAPI            the generated API client — builds and tests with plain `swift test`
```

Everything that is worth unit-testing lives in `Packages/MapleAPI`, which has no
UIKit, no simulator, and no signing requirement. That is why CI runs
`swift test` there first: it fails in about a minute rather than after a full
app build.

## Push notifications

`Maple/Push` owns it. `PushRegistrar` asks for permission the first time an
incident is opened (or from the bell on Home), receives the APNs token via
`AppDelegate`, and keeps `PUT /v2/mobile_devices/{token}` in step with
(token, organization, permission, preferences) through one `.task(id:)` on the
tab root. Registration is per organization; sign-out unregisters. A tapped
notification lands on the incident (`AppNavigation.openIncident`).

The server side is `apps/api/src/services/push` + `platform/Apns.ts`; it sends
only when `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_PRIVATE_KEY` are set on the
alerting worker. `aps-environment` in the entitlements is `development` and
Xcode flips it for archives; the app reads whichever landed in the embedded
profile to pick the APNs host, and treats a missing profile (TestFlight and App Store
installs have none — Apple re-signs and strips it) as production. The simulator on Apple silicon does get a token, but
nothing is delivered to it from a Worker — registering from the simulator
leaves a row Apple rejects with `BadDeviceToken`, which disables it.

## The Lock Screen Live Activity

A **critical** incident raises a Live Activity — the card that sits on the Lock
Screen until the incident resolves, counting how long it has been going on. It
is declared in the same widget extension (`Widgets/IncidentActivityWidget.swift`)
but it is not on a timeline: what it shows is whatever the last APNs push said.

Three tokens are in play, which is the whole complexity of the feature:

| Token               | Who issues it             | What it does             |
| ------------------- | ------------------------- | ------------------------ |
| APNs device token   | iOS, once per install     | notifications            |
| push-to-start token | ActivityKit, per install  | **creates** an activity  |
| activity push token | ActivityKit, per activity | **updates and ends** one |

The push-to-start token means the phone never has to have opened the app for an
incident to appear: it rides along on the device registration, and the server
pushes to it directly. The activity's own token only exists once the activity is
running and is handed to the _app_, so `LiveActivityController` posts it back to
`PUT /v2/mobile_devices/{token}/live_activities/{incident_id}`. Without that
second token an activity would start and then freeze on the numbers it started
with. Because both ride on the device row, a phone that refused notification
permission gets no Live Activities either — the registration that carries the
start token never happens.

Server side, `MobilePushService.syncLiveActivities` starts on `trigger`, updates
on `renotify`, and ends on `resolve` with a resolved state that clears itself
after five minutes. The activity is sent **in addition to** the notification,
never instead of it.

The card carries a sparkline of the last twelve checks with the threshold ruled
off dashed — the shape answers what the number cannot, which is whether this is
still climbing. Two details make it honest: the current value is **appended** to
the series server-side, because `alert_checks` goes through the ingest pipeline
and the check that fired the push is usually not queryable yet; and the chart is
**not zero-anchored** here (`Sparkline(anchorsToZero: false)`), because at 30pt
tall a zero-anchored 2%→9% climb is a flat line. The checks are read lazily —
`IncidentPushEvent.recentValues` is an unevaluated Effect, so the warehouse query
happens only for a critical incident that has somewhere to draw itself.

Two shapes are wire contracts with no runtime error when they drift, so both are
pinned by tests in `MapleWidgetDataTests`:

- the **type name** `IncidentActivityAttributes`, which the start push names in
  `aps.attributes-type` (`LIVE_ACTIVITY_ATTRIBUTES_TYPE` on the server), and
- the **snake_case coding keys and epoch-second dates** in
  `IncidentActivityAttributes`. ActivityKit decodes with a plain `JSONDecoder`,
  whose default date strategy is Apple's 2001 reference date — an ISO-8601
  string does not decode, and a failed decode is silence, not an error.

Live Activities render in the simulator but cannot receive pushes; verifying the
push path needs a device. `NSSupportsLiveActivities` is on the **app's**
Info.plist, not the extension's.

## The Home Screen widgets

`Widgets/` is a WidgetKit extension with two widgets:

- **Ongoing issues** — what the app's "Needs attention" filter returns over the
  last 24 hours, worst first (severity, then whether it is paging, then
  recency). Small, medium and large, plus all three Lock Screen accessories. A
  row taps through to that issue (`maple://issue/<id>`), the rest of the widget
  to the Errors list (`maple://issues`).
- **Throughput** — traffic over the last hour with its trend, error rate and
  p95, for the whole organization or for **one service the user picks in the
  widget itself** (long-press → Edit Widget → Service). That picker is an
  `AppIntentConfiguration`: `SelectServiceIntent` with a `ServiceEntity` whose
  query reads the published snapshot, so the choices are the services the app
  last saw — the extension queries nothing. Unset means the organization total,
  which is the useful default. Taps open the service (`maple://service/<name>`)
  or the Services tab.

Deep links are handled by `AppNavigation.open(_:)`, which owns both tab stacks.
Every widget must also be listed in `MapleWidgetBundle` — one that compiles but
is missing from that body never appears in the gallery, with no error anywhere.

**The extension fetches for itself.** It used to render only what the app had
published, which meant the Home Screen was as fresh as the app's last run — for
most people, hours. The provider was already being woken roughly hourly; it was
spending every one of those wake-ups re-rendering the same bytes.

It still holds no Clerk session — those tokens live one minute, and two
processes refreshing the same rotating refresh token is a way to sign the user
out. Instead the app mints a **device credential** for it (`WidgetCredential`,
`PUT /v2/widget_credentials/{installation_id}`): read-only, 30 days, and fenced
by the server to `/v2/widget_summary` and nothing else. It lives as a file in
the App Group with `completeUntilFirstUserAuthentication` — not `UserDefaults`,
which would be a bearer token in cleartext in a backup, and not the app's
keychain group, which is where Clerk keeps the session this design exists to
keep out of the extension.

The extension still does not link `MapleAPI`: it gets ~30MB and a few seconds,
and the generated client is 30k lines plus `OpenAPIRuntime`. The hand-written
client for that one endpoint is `WidgetSummaryFetcher`, and the whole module —
snapshots, ranking, store, formatters, fetch — is
`Packages/MapleAPI/Sources/MapleWidgetData`, covered by `swift test`.

The fetch **enriches** a timeline; it never gates one. `makeEntry` runs first and
would answer on its own, so a fetch that fails, times out, or never happens
costs nothing but freshness — the widget renders its last snapshot with an
honest age, which is what it did before it could fetch at all. The rules that
keep that true:

- 5s total budget, `waitsForConnectivity = false`. A killed provider costs a
  rebuild from a metered budget having rendered nothing.
- Snapshots are written to the App Group **before** the entries are built, so a
  provider killed on the way to rendering still leaves the data behind.
- One fetch covers both widgets, and `WidgetSummaryFetcher` coalesces: three
  pinned instances woken together make one request between them. A stamp written
  to the App Group before the request covers the app racing the extension.
- A 401 or 403 is **terminal**. A rolled credential answers 401 forever, and
  retrying every rebuild would spend the whole day's budget on failures. Only
  the app can lift it, by minting again — which it does, and then reloads.
- `refreshAfter` stays at 45 minutes. The date in a `TimelineReloadPolicy` is a
  floor, not a promise: asking four times as often does not get four times the
  rebuilds, it gets a widget that has spent its allotment by mid-afternoon.
  Repeated failures back off further (15m → 30m → 1h → 4h).

The extension links no telemetry, so a fetch that fails there fails in complete
silence — which is the exact shape of the bug this replaced. It records
`WidgetFetchState` into the App Group and `WidgetPublisher` drains it onto the
next `widget.refresh` span.

One organization costs **one request**: `GET /v2/widget_summary`, which returns
both surfaces in a payload sized for a Home Screen. It used to cost four —
issues, the service list, a `group_by: service` timeseries and an ungrouped one
— and the composition was the problem: a `BGAppRefreshTask` gets tens of
seconds, and four round-trips per organization is how a background round runs
out of them having written nothing.

That endpoint is deliberately its own scope family rather than a shaped view
over `/v2/error_issues` + `/v2/services` + `/v2/traces/timeseries`. An API key's
required scope is derived from the first path segment, so a credential scoped
`widget_summary:read` reaches exactly this endpoint — which is what will let a
device credential live on a phone without being an organization read key.

The wire carries bucket **counts** and the bucket length; `WidgetSummaryPayload`
divides them on the way into a snapshot, so the sparkline and the headline are
both "per second" and cannot disagree. It also carries the raw naming fields
(`exception_type`, `error_label`, `exception_message`) rather than a rendered
title: `WidgetIssueTitle` owns the fallback and the app's issue list uses it
too, so a title cannot resolve differently on the Home Screen than in the list.

The app still publishes, in a reduced role the extension cannot cover: it owns
the organization index (the picker, and how an unconfigured widget resolves),
mints and renews credentials, warms a newly placed widget so it renders
immediately rather than showing "Open Maple", and clears everything on sign-out.
Four things trigger it:

- the tabs appearing, and every return to the foreground (`RootView`),
- an organization switch — the counts belong to one org, so a switch republishes
  at once rather than leaving the previous org's numbers on the Home Screen,
- `BGAppRefreshTask` while the app is closed (`WidgetRefreshScheduler`), kept as
  a fallback for one release now that the widget refreshes itself,
- a push arriving (`AppDelegate`).

An incident also sends a **silent wake-up** (`content-available`, priority 5,
collapsed per organization) so the Home Screen does not wait for the next
scheduled rebuild at the one moment its numbers are most wrong. It is a hint,
never a guarantee: iOS throttles background pushes on an unpublished schedule,
and it only reaches phones that accepted notifications at all. The widget's own
refresh is the mechanism; this makes it timely. See
`MobilePushService.refreshWidgets`.

The widgets render their own age rather than implying the numbers are current:
past thirty minutes they dim and say "updated 2h ago". Sign-out clears both
snapshots and the credential, locally and server-side; the Home Screen outlives
the session.

Both targets carry the App Group entitlement. With automatic signing Xcode
creates the group on first build; a mismatch between the two entitlements files
and `IssuesSnapshotStore.appGroupIdentifier` is silent — the widget simply
renders "Open Maple" forever.

## Running without a sign-in

Set `MAPLE_FIXTURES=1` in the scheme's environment (Product → Scheme → Edit →
Run → Arguments), or from the CLI:

```bash
SIMCTL_CHILD_MAPLE_FIXTURES=1 xcrun simctl launch booted com.maple.mobile
```

Add `MAPLE_FIXTURES_FAIL_EVERY=3` (any `n`) to make every nth request fail as
if offline — the way to see the error state, the "Couldn't refresh" strip, and
"Try again" without pulling the plug.

`FixtureAPI` then stands in for the network with one believable organization
(nine services, a critical incident, a warning, issues, an anomaly), generated
relative to now so timestamps always read as current, and the session is pinned
to `.ready` without touching Clerk. This is how screens get built and
screenshotted; it is not a test double for logic — that stays in
`Packages/MapleAPI`.

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

| Contract emits                    | Without normalization              | After     |
| --------------------------------- | ---------------------------------- | --------- |
| `anyOf: [T, null]`                | `Union_23` with `.value1: String?` | `String?` |
| `anyOf: [number, enum["NaN", …]]` | a struct wrapping a `Double`       | `Double`  |
| `allOf: [{minLength}, {pattern}]` | struct with `value1`/`value2`      | `String`  |

It also prunes to the operations the app calls, merges the per-annotation-site
copies of a domain enum (`_maple_AlertSignalType_2` → `_maple_AlertSignalType`)
so one wire enum is one Swift enum, and collapses every error response to a
single `MapleErrorEnvelope`. Result: ~75 schemas instead of 480.

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

Memberships are fetched with `user.getOrganizationMemberships(page:pageSize:)`,
paging to the reported total. Do **not** read `user.organizationMemberships`:
it is an `Optional` populated from the client payload and can be absent or
partial, which previously auto-selected multi-org accounts into whichever
organization happened to be in that payload. The auto-select-when-one path only
runs against a verified list.

The switcher lives in the title slot on both tabs. The gate alone is not enough:
once an organization is active the gate is unreachable, so without it a
multi-org account is stuck.

## The environment axis

Everything on screen is scoped twice: by organization, and by **deployment
environment**. `EnvironmentController` owns the second, and it is deliberately
shaped like the first — one app-wide choice, a control next to the switcher, and
a change that invalidates every screen at once rather than each screen growing
its own filter.

The mechanism is where they differ, and the difference is the thing to know:

- The **organization** travels in the session token, so every request carries it
  whether the endpoint knows about it or not.
- The **environment** is a query parameter or body field, **per endpoint**. So
  `MapleClient.scoped(toEnvironment:)` reaches the reads that declare one and
  silently does not reach the rest.

What it does not reach, and why:

| Read                                | Behaviour                                                         |
| ----------------------------------- | ----------------------------------------------------------------- |
| `GET /v2/services/{name}`           | Aggregates across environments by contract — service detail is unfiltered. |
| `/v2/alerts/*`                      | No filter exists. A rule's `environments` is the scope it fires on, not a filter over rules. |
| `GET /v2/error_issues/service_counts` | No parameters at all. **The one visible seam:** with an environment selected, a Services row's metrics are filtered and its open-issue badge is not. |

`GET /v2/anomalies/incidents` spells the parameter **`deployment_env`**, not
`deployment_environment`. It is the only one that does; sending the long name
there is not an error, it is an ignored parameter and an unfiltered list.
`EnvironmentScopeTests` pins it.

The picker's options come from `GET /v2/environments`, not from unioning
`deployment_environments` across a page of services — that listing is capped by
its own `limit`, so an environment appearing only on the hundredth service would
never be offered. The blank environment is never returned: the warehouse DSL
reads `''` as "no filter", so offering it would hand back every environment
under a label claiming otherwise.

The selection persists in `UserDefaults.standard` **keyed per organization**.
A single key would carry "staging" into an organization that has no such
environment, where it filters every screen to nothing and looks like an outage;
a stored value the organization does not have falls back to all environments.

Widgets pin their own environment, the way they pin their own organization —
two widgets, two environments, both correct at once. That makes snapshots
per `(organization, environment)`: one slot per organization would let a
production widget and a staging widget overwrite each other on every publish,
each then rendering the other's numbers under its own label. The unfiltered slot
keeps the key it always had, so a widget placed before this shipped needs no
migration.

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

# Product

## Register

product

## Users

Engineers on call — SRE, backend, and platform — using Maple during incident triage, capacity review, and routine service-health checks. They open the dashboard mid-page, often on a large monitor in a dim room at 2am. Job-to-be-done: find the slow span, broken log line, or misbehaving service in seconds, with zero ambiguity about cost or retention.

Secondary persona: platform teams self-hosting Maple under Apache 2.0 who need the dashboard to feel like a peer-built tool — not a vendor product they bought.

## Product Purpose

Open-source OpenTelemetry observability that is transparent on cost and sovereign on hosting. Surfaces traces, logs, metrics, errors, alerts, infrastructure, and service maps with no per-host fees and clear usage-based ingest.

Success looks like an engineer reaching the offending span from a page alert in under 10 seconds — without thinking about pricing tiers, vendor lock-in, or which OTel dialect to use.

## Brand Personality

**Precise, calm, expert.** Voice is a confident technical peer — Linear/Vercel-adjacent in posture, not Datadog-marketing-adjacent.

Tone is sober and specific: numbers, units, exact identifiers. No exclamation points, no "magic," no marketing adjectives in product copy. Empty states explain what is missing, not what is possible. Errors describe the failure, not apologize for it. Dense, numerical, deliberately not pretty — but polished where it counts (typography, motion, alignment).

## Anti-references

Explicitly do not look like:

- **Datadog product chrome.** Upsell banners, gradient cards, overpacked top nav, visually busy panels that compete with the data.
- **AI-startup neon-on-black.** Generic dark theme plus electric accent plus glow effects. The currently-saturated AI-tool reflex; cliché the moment you reach for it.
- **New Relic enterprise UI.** Dated tabs, deep nested settings, beige-corporate density.
- **SaaS-cream landing patterns leaking into the product.** Hero-metric templates (big number, small label, supporting stats, gradient accent), identical icon-card grids, friendly illustrations.

North stars (for posture, not pixels): **Linear** (compact app shell, precise motion, command-bar fluency, restrained color) and **Vercel / Axiom** (monospace prominence, severity coloring, terminal-native dark mode).

## Design Principles

1. **Fast trust over reassurance.** The dashboard's job is to be right and fast, not soothing. Skip loading theater, skip success animations, skip "you're awesome" empty-state copy. Show the data; let speed be the comfort.
2. **Density without noise.** Engineers scan, they do not browse. Every element earns its pixel: no decorative gradients, no icon-as-garnish, no card chrome wrapping a single value. High info-per-pixel, but every datum is load-bearing.
3. **Cost honesty in the UI.** Surface ingest cost, retention, and sampling consequences where engineers act, not buried in billing. If transparent pricing is the differentiator, the product cannot hide what it costs to ask a question.
4. **Dark by default, light when ambient demands.** Default theme follows the physical scene (operator at a dim 27" monitor at 2am), not aesthetic preference. Light mode is a peer mode, not a fallback.
5. **Practice what you preach.** Dogfood our own traces, logs, and errors inside the dashboard. If a Maple page is slow, the trace for that page should be one click away.

## Accessibility & Inclusion

WCAG AA target across both themes.

Color is never the only signal. Severity tiers (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) pair color with type weight and an explicit label. The 16-color categorical service palette is supplemented by service initials or icons, since categorical color encoding alone fails under deuteranopia and protanopia at that count.

Motion respects `prefers-reduced-motion`; given the "fast trust" stance, motion is sparse anyway. Long-session ergonomics: dark mode tuned for low-light viewing without crushing chroma at extremes; line lengths capped on prose surfaces; focus rings always visible on dark (no chroma-stripping on focus).

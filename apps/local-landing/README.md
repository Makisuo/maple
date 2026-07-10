# @maple/local-landing

Standalone marketing + docs site for **Maple Local** — the single-binary local
OpenTelemetry tool built from `apps/cli`. Astro 5, same amber/Geist branding as
`apps/landing`, deployed as a Cloudflare Worker (static assets + tiny
`src/worker.ts` passthrough) via Alchemy.

```bash
bun run --cwd apps/local-landing dev:app   # dev server on :3392 (or `bun dev` via portless)
bun run --cwd apps/local-landing build     # static build into dist/
```

Docs live in `src/content/docs/` (groups: Getting Started, Sending Data,
Reference, Operations — ordering in `src/lib/docs-nav.ts`). The `build`/`dev`
scripts copy `scripts/install.sh` / `uninstall.sh` into `public/cli/` so the
site serves `/cli/install` like maple.dev does.

## Domain setup (manual, one-time)

The site targets the apex domain `maplelocal.dev`, which is **not** created by
the deploy — Alchemy can only attach a worker to a zone that already exists:

1. Buy `maplelocal.dev` and add it as a new zone in the same Cloudflare account.
2. Point the registrar's nameservers at Cloudflare and wait for the zone to go
   active.
3. Uncomment the `localLanding` entries in
   `packages/infra/src/cloudflare/stage.ts` (`PRD_DOMAINS` / `STG_DOMAINS`).
4. Recommended: add a `www` → apex redirect rule in the zone.

Until then the worker deploys on its workers.dev URL (same fallback as PR
previews). If a different apex is bought instead, update the two entries in
`stage.ts` and `site` in `astro.config.mjs`.

# Electric Agents — upstream issues we work around

The chat-agent (`apps/chat-agent`) runs on
`@electric-ax/agents-runtime@0.2.1` against agents-server `0.4.0`. Several
warts in that stack still require workarounds in our code. This file lists
them so we can mechanically delete the workaround when a future bump
fixes the underlying issue.

Each entry is keyed by the bug number used in code comments (`// upstream
bug #N`). Re-verify status when bumping `@electric-ax/agents-runtime` or
the `electricax/agents-server:*` image tag in
[`apps/chat-agent/docker-compose.electric.yml`](../apps/chat-agent/docker-compose.electric.yml).

| # | Issue | Status as of 2026-05 | Where we work around it |
|---|-------|----------------------|--------------------------|
| 2 | `registerTypes()` PUT used wrong subscription URL/body → wake events never fired | **Fixed** in agents-server 0.4.0 (auto-registers per-entity webhook from `dispatch_policy`) | No-op now |
| 3 | `db.preload()` + `useChat`/`useLiveQuery` never surface entity-stream events (state-beta `markUpToDate` plumbing) | Open | **Bypassed** by using shared-state collections + `useLiveQuery` instead of entity-stream `useChat(db)` |
| 4 | Two concurrent PUTs for the same entity URL → both 500 (LMDB race in `streamMetaToStream`) | Open | `inflightSpawns` single-flight in [`src/server.ts`](../apps/chat-agent/src/server.ts) |
| 5 | `publicUrl` must be `localhost`/`127.0.0.x` or webhook registration fails | Open | `ELECTRIC_AGENTS_BASE_URL=http://localhost:4437` in the compose file + `handleWebhookWithCallbackRewrite` rewrites the inbound body's loopback URLs back to `AGENTS_URL` |
| 6 | `runtime.onEnter` passes a `Buffer` to `new Request(url, { body })` → undici rejects with `Symbol(kState)` | Open | We construct the `Request` manually with a `Uint8Array` body and call `runtime.handleWebhookRequest` directly |
| 7 | agents-server <0.4.0 webhook-forward body parser crashes on non-empty bodies | **Fixed** in 0.4.0 (we already pin it) | Pin in [`docker-compose.electric.yml`](../apps/chat-agent/docker-compose.electric.yml) |
| 8 | `ctx.firstWake` is `true` on every wake | Open | The handler doesn't gate on `firstWake`; it observes the shared state and decides to respond based on whether the latest user message already has a reply |
| — | agents-server proxy uses `new Response(body, { status })` which throws on 204 | Open | We rewrite the runtime's `204 No Content` reply to `200 OK` in `handleWebhookWithCallbackRewrite` |

## Local-infra gotchas

- **Don't ever bind `4437` on the host.** OrbStack's container port-forward
  can survive `docker rm`, leaving an unbindable phantom on 4437. The
  compose file maps host `4440` → container `4437` to sidestep it.
- **`bun electric:reset` is the surgical reset** when state drifts
  (orphaned entity rows, stale durable streams, Electric publication
  caches). The volumes only hold local dev data.
- **Schema drift on long-lived volumes** — the persistent
  `maple-electric-agents-electric-agents-postgres-data` volume from older
  agents-server versions can leave Electric's cached publication out of
  sync. `bun electric:reset` clears it.

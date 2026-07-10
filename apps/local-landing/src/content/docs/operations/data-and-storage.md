---
title: "Data & storage"
description: "How the embedded ClickHouse store works, where data lives on disk, and how recovery behaves after an unclean shutdown."
group: "Operations"
order: 2
---

Maple Local stores telemetry in an **embedded ClickHouse** — [chDB](https://github.com/chdb-io/chdb), the in-process ClickHouse engine — loaded directly into the `maple` process via FFI. No database server, no container: one process owns everything.

## One process, one connection

chDB allows exactly one connection per process, so the long-lived `maple start` process owns it. Short-lived query commands (`maple traces`, `maple query`, …) don't open the store themselves — they reach the running server over HTTP on loopback. That's why query commands need `maple start` running.

Everything is single-tenant: every row is written under `org_id = "local"`, and every compiled query filters on it.

## Where data lives

| Path | Contents |
| --- | --- |
| `~/.maple/data` | The ClickHouse store — traces, logs, metrics (persists between runs) |
| `~/.maple/config.json` | CLI config: pinned mode, tokens, update-check cache |
| `~/.maple/maple.log` | Server log when started detached (`maple start -d`) |
| `~/.maple/bin` | Binary + `libchdb` when installed via the curl installer |

Override the store location per server with `maple start --data-dir <path>`.

## Wiping the store

```bash
maple reset            # wipe the store (server stopped)
maple start --reset    # wipe and start fresh in one step
```

## Store versioning & crash recovery

Two sentinel files beside the store guard its integrity:

- **`maple-store-version.json`** records which chDB build bootstrapped the store. A different chDB build can't be trusted to reload another's persisted materialized views (it could crash the engine natively), so after an upgrade that changes chDB, `maple start` refuses up front and tells you to run `maple start --reset`.
- **`maple-store-open`** is a clean-shutdown sentinel. It's written right after the store opens and removed as the last step of a clean close. If `maple start` finds it still present over a populated store, the previous server died without closing cleanly and the store may be inconsistent — rather than risk a native crash, the server **auto-wipes the store and bootstraps fresh**, printing a warning.

The practical takeaway: local telemetry is scratch data. It survives normal restarts fine, but it is **not recoverable** after an unclean kill of the server — re-ingest to repopulate. Anything you need durably belongs in a hosted workspace.

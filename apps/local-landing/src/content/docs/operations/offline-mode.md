---
title: "Offline mode"
description: "Where the dashboard comes from, why the browser may prompt, and how --offline serves everything from 127.0.0.1."
group: "Operations"
order: 1
---

The dashboard SPA is a single build served two ways, and it decides which `/local/query` base URL to use from `window.location`.

## Default: the hosted dashboard

`maple start` points you at the dashboard deployed to `local.maple.dev`. The page is static — it talks back to **your** binary on loopback, so your telemetry never leaves the machine. Serving the UI from a public origin decouples UI updates from binary releases: dashboard fixes ship by deploying, no new binary needed.

Because that page is a *public* origin, its queries to `http://127.0.0.1:<port>/local/query` are a **public → loopback** request, which trips the browser's Private Network Access gate. The server answers the preflight correctly (`Access-Control-Allow-Private-Network: true`), but recent Chrome may still show a one-time "wants to access devices on your local network" prompt; Safari and Firefox differ.

The startup banner encodes the bound port as `?port=`, so links keep working on non-default ports. `MAPLE_LOCAL_UI_URL` overrides the default UI origin.

## `--offline`: everything from the binary

```bash
maple start --offline
```

The binary serves the dashboard bundled inside it from `127.0.0.1`, so queries are same-origin: no CORS, no Private Network Access, no permission prompt — and it works with **no internet connection at all**. This is the recommended escape hatch whenever the default path hits a browser prompt, and the right mode for air-gapped machines.

The bundled copy is baked in at release time, so it can trail the hosted dashboard slightly; upgrade the binary to pick up UI changes in offline mode.

## Which URL do I open?

You don't need to remember — the `maple start` banner always prints the right URL for the mode you chose.

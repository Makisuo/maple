---
title: "Railway"
description: "Connect Railway to Maple with an API token — Maple streams your services' runtime logs and collects CPU, memory, network, and disk metrics for every service."
group: "Integrations"
order: 4
---

Railway has no log-drain feature — there is no setting to forward a service's stdout to an external intake URL. Its [public GraphQL API](https://docs.railway.com/integrations/api) is the only programmatic way at your logs and resource metrics. Maple supports this natively: you paste one API token, pick the environments to ingest, and Maple's connector streams runtime logs over Railway's GraphQL subscription API and polls per-service resource metrics — no code changes, sidecars, or forwarder services in your Railway project.

## 1. Create an API token

In Railway, open **Account Settings → Tokens** and create a token:

- A **workspace token** (recommended) is scoped to one workspace and can read all of its projects.
- An **account token** works too and covers every workspace you belong to.
- **Project tokens are not supported** in this version — they authenticate differently and cannot enumerate projects.

## 2. Connect it in Maple

Open **Integrations → Railway** in the Maple dashboard and paste the token. Maple validates it against Railway's API, stores it encrypted (AES-256-GCM — it is never sent back to the browser), and discovers your projects, environments, and services.

## 3. Pick environments

Toggle **Ingest** on each project environment you want in Maple. Logs and metrics can be toggled independently per environment. Every Railway service in an ingested environment appears in Maple as its own service (`service.name` = the Railway service name, `service.namespace` = the project name), tagged with `cloud.provider=railway` and `railway.project/environment/service` resource attributes.

## What you get

- **Runtime logs**, live: each service's stdout/stderr as Maple log records, with Railway's severity mapped onto OTLP severity and the deployment id attached (`railway.deployment.id`). Build and deploy logs and HTTP edge logs are not ingested in this version.
- **Resource metrics**, polled every 5 minutes by default (configurable 1–60 min per environment):
  - `railway.cpu.usage` / `railway.cpu.limit` (vCPU)
  - `railway.memory.usage` / `railway.memory.limit` (bytes)
  - `railway.network.rx` / `railway.network.tx` (bytes)
  - `railway.disk.usage` (bytes)

## Rate limits

Railway rate-limits API calls by **your Railway plan** — 100 requests/hour on Free, 1,000 on Hobby, 10,000 on Pro. Metrics polling costs roughly one request per service per interval; the log stream is a single long-lived connection per environment. Maple reads Railway's rate-limit headers and automatically stretches poll intervals when the remaining budget runs low, but on the Free plan with many services expect metrics to arrive less often than the configured interval.

## Notes

- Ingested logs and metrics count toward your Maple ingestion volume like any other OTLP data.
- If you revoke or rotate the token in Railway, the integration card shows a **Reconnect needed** banner — paste the new token to resume. Ingestion pauses (it never falls back to another credential) until you do.
- Short gaps in the log stream can occur around reconnects (for example a Railway API deploy); metrics polling backfills up to an hour automatically.

---
title: "Maple API"
description: "The Maple REST API: base URL, API keys and scopes, conventions, the error envelope, rate limits, and where the OpenAPI specification lives."
group: "Getting Started"
order: 8
---

The Maple API is the public, stability-committed HTTP interface to everything in your Maple organisation: dashboards, alert rules and destinations, error issues and investigations, scrape targets, ingest and API keys, and read access to traces, logs, metrics, services, and session replays. The dashboard uses the same endpoints you do.

| | |
| --- | --- |
| Base URL | `https://api.maple.dev/v2` |
| Interactive reference | [api.maple.dev/v2/docs](https://api.maple.dev/v2/docs) |
| OpenAPI 3.1 specification | [maple.dev/openapi.json](/openapi.json) (also [api.maple.dev/openapi.json](https://api.maple.dev/openapi.json)) |
| MCP server for AI agents | [Maple MCP server](/docs/mcp) |
| Auth | `Authorization: Bearer maple_ak_…` |

## Authentication

Create an API key in the Maple dashboard under **Settings → API keys**, or with `POST /v2/api_keys` using an existing key. Send it as a Bearer token on every request:

```bash
curl https://api.maple.dev/v2/services \
  -H "Authorization: Bearer maple_ak_…"
```

Keys can be **scoped** at creation. A scope is `<family>:read`, `<family>:write`, or `*`, where the family is the first path segment under `/v2` (`dashboards`, `alerts`, `traces`, `error_issues`, …). `write` implies `read`; a key with no scopes has full access. A request outside a key's scopes fails with `403` / `permission_error` / `insufficient_scope`.

Keys belong to one organisation. If your user is a member of several, you can also authenticate with a dashboard session token and pick the organisation with the `x-maple-org-id` header.

## Conventions

- Resources are plural nouns under `/v2` (`/v2/api_keys`, `/v2/alerts/rules`). Non-CRUD verbs are sub-resource POSTs (`POST /v2/api_keys/{id}/roll`); complex reads are `POST …/search`.
- Every object carries an `object` field and a prefixed, opaque public ID (`key_…`, `dash_…`, `alrt_…`).
- Wire format is snake_case JSON with ISO-8601 UTC timestamps. Nullable fields are explicit `null`.
- Lists accept `limit` (1–100, default 20) and an opaque `cursor`, and return `{ "object": "list", "data": [...], "has_more": true, "next_cursor": "…" }`.
- Updates are JSON `PATCH` bodies.

## Errors

Every failure — including an unknown route — is a JSON envelope with the same shape:

```json
{
  "error": {
    "_tag": "@maple/http/v2/RouteNotFoundError",
    "type": "not_found_error",
    "code": "route_not_found",
    "title": "No such route",
    "message": "No route matches GET /v2/typo. The Maple API is documented at https://api.maple.dev/v2/docs; the OpenAPI specification is at https://api.maple.dev/openapi.json.",
    "retryable": false,
    "recovery": "fix_request"
  }
}
```

`type` is one of `invalid_request_error` (400), `authentication_error` (401), `payment_error` (402), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429), or `api_error` (5xx). Branch on `_tag` for exact failures; `code` is a presentation category. `recovery` tells a client what to do: `none`, `fix_request`, `reauthenticate`, `request_access`, `reconnect`, `refresh`, `retry`, or `contact_support`. When `retryable` is true the response also carries `Retry-After`. Stack traces and upstream messages never appear on the wire.

## Rate limits

API-key requests share **600 requests per 60 seconds per key** across the whole `/v2` surface. Over the budget you get `429` with `type: "rate_limit_error"`, `code: "rate_limited"`, and `Retry-After: 60`.

## Using the spec from tools and agents

The OpenAPI document is self-describing: every operation has a unique `operationId`, a `summary` and `description`, typed parameters, request and response schemas, and the exact error `_tag`s it can return. It imports directly into Postman, Insomnia, Scalar, `openapi-generator`, and LLM function-calling shims — point them at `https://maple.dev/openapi.json`.

If you are wiring up an AI agent rather than code, the [MCP server](/docs/mcp) exposes the same capabilities as tools with no client generation step.

## Versioning

`/v2` is the major version; within it, changes are additive and error `_tag` values are the compatibility contract. The v1 endpoints under `/api/…` remain mounted for existing integrations but receive no new features.

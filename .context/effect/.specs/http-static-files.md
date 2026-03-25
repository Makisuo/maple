# HttpStaticFiles: Static File Serving Module

## Overview

Add a new `HttpStaticFiles` module to `packages/effect/src/unstable/http/` that
provides a static file server as an `HttpApp`. It serves files from a directory
using the existing `FileSystem`, `Path`, and `HttpPlatform` services.

Designed to be used as a route handler mounted at a specific path via the
router's wildcard + prefix pattern. Uses a dedicated module rather than living
inside `HttpMiddleware` to keep the scope isolated, consistent with how the
codebase separates concerns (e.g., `Etag`, `HttpBody`, `HttpPlatform`).

## Module Location

`packages/effect/src/unstable/http/HttpStaticFiles.ts`

## Public API

### `HttpStaticFiles.make`

```ts
export const make: (options: {
  readonly root: string
  readonly index?: string | undefined
  readonly spa?: boolean | undefined
  readonly cacheControl?: string | undefined
  readonly mimeTypes?: Record<string, string> | undefined
}) => Effect.Effect<
  Effect.Effect<HttpServerResponse, RouteNotFound, HttpServerRequest>,
  PlatformError,
  FileSystem | Path | HttpPlatform
>
```

Uses `Effect.fnUntraced` per codebase conventions.

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `root` | `string` | (required) | Absolute or relative path to the directory to serve |
| `index` | `string \| undefined` | `"index.html"` | Index file name served when a directory is requested. Set to `undefined` to disable |
| `spa` | `boolean \| undefined` | `false` | When `true` and a file is not found, serves the index file for requests that accept `text/html` (only when the request path has no file extension) |
| `cacheControl` | `string \| undefined` | `undefined` | Value for the `Cache-Control` response header. Not set if `undefined` |
| `mimeTypes` | `Record<string, string> \| undefined` | `undefined` | Extension-to-content-type mapping merged with (and overriding) built-in defaults. Keys are extensions without the dot (e.g., `{ "wasm": "application/wasm" }`) |

**Return type:** An `Effect` that acquires `FileSystem`, `Path`, and
`HttpPlatform` services once at construction time, resolving to an `HttpApp`
(`Effect<HttpServerResponse, RouteNotFound, HttpServerRequest>`). The returned
`HttpApp` is a pure function that does not require additional services.

**Error handling:** The inner `HttpApp` fails with `RouteNotFound` when:
- The resolved path escapes the root directory (directory traversal)
- The file does not exist and SPA fallback is not applicable
- The file is not a regular file (e.g., a directory without a matching index)
- `decodeURIComponent` fails on malformed URI sequences

`PlatformError` from `FileSystem.stat()` or `HttpPlatform.fileResponse()` is
handled internally:
- `PlatformError` with `reason._tag === "NotFound"` is converted to `RouteNotFound`
- Other `PlatformError` values (e.g., permission denied) are propagated as
  defects (unexpected errors) since the file was confirmed to exist via stat

### `HttpStaticFiles.layer`

```ts
export const layer: (options: {
  readonly root: string
  readonly prefix?: string | undefined
  readonly index?: string | undefined
  readonly spa?: boolean | undefined
  readonly cacheControl?: string | undefined
  readonly mimeTypes?: Record<string, string> | undefined
}) => Layer.Layer<never, PlatformError, HttpRouter | FileSystem | Path | HttpPlatform>
```

Convenience layer that constructs the static file handler and mounts it on the
router. Internally does `yield* HttpRouter` to access the router instance
directly. When `prefix` is provided, uses `router.prefixed(prefix).add("GET",
"/*", handler)` which registers the route at `{prefix}/*` and automatically
strips the prefix from `request.url` before the handler sees it. When no prefix,
calls `router.add("GET", "/*", handler)` directly.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefix` | `string \| undefined` | `undefined` | URL path prefix to mount the static handler at (e.g., `"/static"` registers the route at `/static/*`) |

All other options are forwarded to `make`. The route is registered as `GET`
only. The router's built-in HEAD fallback (which tries `GET` when `HEAD` is not
found) handles HEAD requests automatically.

## Usage Examples

### Basic static file serving with router

```ts
import { Effect, Layer } from "effect"
import { HttpRouter, HttpStaticFiles, HttpServerResponse } from "effect/unstable/http"

const ApiRoutes = HttpRouter.add(
  "GET", "/api/health",
  HttpServerResponse.text("ok")
)

// Mount static files at /static/*
const StaticFilesLayer = HttpStaticFiles.layer({
  root: "./public",
  prefix: "/static",
  cacheControl: "public, max-age=3600"
})

const AppLayer = Layer.mergeAll(ApiRoutes, StaticFilesLayer)
```

### SPA mode

```ts
// Mount at root — serves index.html for all unmatched HTML requests
const SpaLayer = HttpStaticFiles.layer({
  root: "./dist",
  spa: true,
  cacheControl: "public, max-age=3600"
})
```

### Manual construction

```ts
const program = Effect.gen(function*() {
  const staticApp = yield* HttpStaticFiles.make({ root: "./public" })
  // staticApp is now an HttpApp — Effect<HttpServerResponse, RouteNotFound, HttpServerRequest>
})
```

## Behavior

### Request-to-File Resolution

1. Extract `request.url` (the pathname portion — already prefix-stripped by the
   router when using `prefixed()`)
2. Strip the query string: take everything before the first `?`
3. Call `decodeURIComponent`. If this throws (malformed URI), return 404
4. Reject paths containing null bytes (`\0`) — return 404
5. Strip the leading `/` from the path
6. Use `Path.normalize()` to collapse `..` and `.` segments
7. **Pre-join traversal check:** After normalization, reject if the path starts
   with `..` (would escape root after join)
8. Use `Path.join(resolvedRoot, normalizedPath)` to get the absolute file path
9. **Post-join traversal check:** Verify the joined path starts with
   `resolvedRoot + path.sep` (or equals `resolvedRoot`). If not, return 404
10. Call `FileSystem.stat()` on the resolved path

The `root` is resolved to an absolute path at construction time using
`Path.resolve()`.

### File Serving Flow

1. If stat succeeds and file type is `"File"`:
   - Resolve MIME type from extension
   - Check for range request (see below)
   - Call `HttpPlatform.fileResponse(path, options)` to create the response
     (handles ETag, Last-Modified, platform-optimized streaming)
   - Set `Content-Type` header based on MIME type
   - Set `Accept-Ranges: bytes` header
   - Add `Cache-Control` header if configured
   - Check conditional request headers (see below) — may convert to 304
   - Return the response

2. If stat succeeds and file type is `"Directory"`:
   - If `index` is configured, try to serve `path/{index}` (recurse to step 1)
   - Otherwise return 404 via `RouteNotFound`

3. If stat fails (file not found):
   - If `spa` is `true` AND request `Accept` header includes `text/html` AND
     the request path has no file extension: serve `root/{index}`
   - Otherwise return 404 via `RouteNotFound`

### Method Handling

The route should be registered with method `"GET"`. The router's built-in HEAD
fallback automatically handles HEAD requests by trying the GET handler. No
explicit HEAD handling is needed.

For any other methods, the router returns 404 (the route simply doesn't match).

### Conditional Requests (304 Not Modified)

After building the response via `HttpPlatform.fileResponse()` (which sets `ETag`
and `Last-Modified` headers automatically):

1. **`If-None-Match`:** If request has `if-none-match` header:
   - Split the header value by `,` and trim each entry
   - Compare each entry against the response `ETag` using weak comparison
     (strip `W/` prefix from both sides before comparing)
   - If any entry matches (or the header value is `*`), return 304
2. **`If-Modified-Since`:** If request has `if-modified-since` header and **no**
   `if-none-match` header:
   - Parse the date using `new Date(value)`
   - Compare with the response `Last-Modified` header
   - If the file has not been modified since, return 304

The 304 response:
- Uses `HttpServerResponse.empty({ status: 304 })`
- Preserves `ETag`, `Cache-Control`, and `Last-Modified` headers from the
  original response
- Does **not** include `Content-Length` or `Content-Type`

**Note:** The current implementation calls `HttpPlatform.fileResponse()` before
checking conditionals, which means the file is statted twice (once internally by
`fileResponse`, once earlier for our own stat). This is a simplicity tradeoff —
`fileResponse` handles ETag generation and platform-specific response creation.
A future optimization could stat once and pass info through, but this would
require changes to the `HttpPlatform` API.

### Range Requests (206 Partial Content)

Single-range requests only. When the request includes a `Range` header:

1. Parse the `Range` header. Supported formats:
   - `bytes=start-end` — specific byte range (inclusive)
   - `bytes=start-` — from start to end of file
   - `bytes=-suffix` — last N bytes of file
2. Validate the range against the file size (from stat)
3. If the range is valid:
   - Use `HttpPlatform.fileResponse()` with `offset` and `bytesToRead` options
   - Set response status to `206`
   - Set `Content-Range: bytes start-end/total` header
   - Set `Accept-Ranges: bytes` header
   - Set `Content-Type` header
4. If the range is not satisfiable:
   - Return `416 Range Not Satisfiable`
   - Set `Content-Range: bytes */total` header
5. If the `Range` header is malformed or contains multiple ranges:
   - Ignore it and serve the full file (200)

Range requests are only processed for GET requests. The 304 check takes
precedence over range handling — if the conditional check results in 304, the
range header is ignored.

All successful (200) responses include `Accept-Ranges: bytes` header to
advertise range support.

### Built-in MIME Type Map

A default mapping of common file extensions to content types:

```ts
const defaultMimeTypes: Record<string, string> = {
  // Text
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml; charset=utf-8",
  ico: "image/x-icon",
  webp: "image/webp",
  avif: "image/avif",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  // Media
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  // Other
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  wasm: "application/wasm",
  map: "application/json",
  webmanifest: "application/manifest+json"
}
```

Unknown extensions default to `"application/octet-stream"`.

User-provided `mimeTypes` are merged on top of defaults:
`{ ...defaultMimeTypes, ...options.mimeTypes }`.

MIME type is resolved from the file extension using `Path.extname()`, stripping
the leading dot, lowercased.

### Directory Traversal Protection

Defense-in-depth approach using both pre-join and post-join validation:

1. After `decodeURIComponent`, reject paths containing null bytes (`\0`)
2. Strip leading `/` from the decoded path
3. `Path.normalize()` the path to collapse `.` and `..` segments
4. **Pre-join check:** Reject if normalized path starts with `..` (relative escape)
5. `Path.join(resolvedRoot, normalizedPath)` to get the absolute file path
6. **Post-join check:** Verify the joined path starts with
   `resolvedRoot + path.sep` or equals `resolvedRoot`

Both checks are needed because `Path.normalize("/../../../etc/passwd")` returns
`"/../../../etc/passwd"` (still starts with `/`), so the pre-join `..` check
only catches relative escapes. The post-join prefix check catches all remaining
cases.

### Security Considerations

- **Symlinks:** The implementation follows symlinks (via `FileSystem.stat()`).
  Symlinks pointing outside the root are caught by the post-join traversal
  check only if the symlink target path was resolved. Since `Path.join` does not
  resolve symlinks (it's a string operation), a symlink inside root pointing to
  `/etc/passwd` would be served. This is acceptable for the initial
  implementation — users who need symlink restriction should handle it at the OS
  level. A `followSymlinks` option could be added later.

- **Hidden files (dotfiles):** No special handling. Files starting with `.` are
  served like any other file. Users can add path-based filtering via middleware
  if needed.

- **`decodeURIComponent` throwing:** Malformed URI sequences (e.g., `%E0%A4%A`)
  cause `decodeURIComponent` to throw. This is caught and returns 404.

## Dependencies

The `make` function requires these services at construction time:

- `FileSystem` — for `stat()` and file existence checks
- `Path` — for `join()`, `normalize()`, `extname()`, `resolve()`
- `HttpPlatform` — for `fileResponse()` which handles ETag generation,
  Last-Modified, and platform-optimized file streaming

The returned `HttpApp` does not require any additional services in its `R` type
(only `HttpServerRequest`, which is always provided by the router).

## Implementation Plan

### Task 1: Create the `HttpStaticFiles` module with full implementation

Create `packages/effect/src/unstable/http/HttpStaticFiles.ts` with:

- Top-level `/** @since 4.0.0 */` JSDoc (required for barrel file generation
  via `pnpm codegen`)
- The `defaultMimeTypes` map
- A `resolveMimeType(path: Path, filePath: string, mimeTypes: Record<string, string>): string` helper
- A `resolveFilePath(path: Path, root: string, url: string): string | undefined` helper
  that extracts the file path from the URL, handles decoding, normalization,
  and traversal checks. Returns `undefined` if the path is invalid.
- The `make` function using `Effect.fnUntraced`:
  - Acquires `FileSystem`, `Path`, and `HttpPlatform` from the service context
  - Resolves the `root` to an absolute path using `Path.resolve()`
  - Merges user MIME types with defaults
  - Returns an `HttpApp` that:
    - Extracts `request.url`, calls `resolveFilePath`
    - Stats the file via `FileSystem.stat()`
    - For regular files: calls `HttpPlatform.fileResponse()`, sets
      `Content-Type`, `Accept-Ranges: bytes`, optional `Cache-Control`
    - For directories with index configured: tries `path/{index}`
    - For not-found with `spa: true`, request accepting `text/html`, and no
      file extension in path: serves `root/{index}`
    - Catches `PlatformError` with `reason._tag === "NotFound"` and converts
      to `RouteNotFound`
    - Otherwise fails with `new RouteNotFound({ request })`
- The `layer` convenience function:
    - Uses `yield* HttpRouter` to access the router instance directly
    - When prefix is set: `router.prefixed(prefix).add("GET", "/*", handler)`
    - When no prefix: `router.add("GET", "/*", handler)`
- JSDoc with `@since 4.0.0`, `@category`, and `@example` tags on `make` and `layer`
- Run `pnpm codegen` to generate barrel file export
- Run `pnpm docgen` to verify JSDoc examples compile
- A changeset in `.changeset/` (package: `effect`, type: `minor`)
- Ensure `pnpm check:tsgo` and `pnpm lint-fix` pass

### Task 2: Add conditional request handling (304 Not Modified)

Extend the file serving logic in `HttpStaticFiles.make`:

- After getting the response from `HttpPlatform.fileResponse()`, check request
  `if-none-match` and `if-modified-since` headers
- For `if-none-match`: split by `,`, trim, compare with weak comparison
  (strip `W/` prefix) against response `ETag`
- For `if-modified-since` (only when no `if-none-match`): parse date, compare
  with response `Last-Modified`
- Return `HttpServerResponse.empty({ status: 304 })` with preserved `ETag`,
  `Cache-Control`, and `Last-Modified` headers when conditions match
- Ensure `pnpm check:tsgo` and `pnpm lint-fix` pass

### Task 3: Add range request support (206 Partial Content)

Extend the file serving logic:

- Add a `parseRange(header: string, fileSize: number): { start: number; end: number } | undefined`
  helper that handles:
  - `bytes=start-end` (inclusive)
  - `bytes=start-` (to end of file)
  - `bytes=-suffix` (last N bytes)
  - Returns `undefined` for malformed or multi-range headers
- Before calling `HttpPlatform.fileResponse()`, check for `Range` header
- For valid ranges: pass `offset` and `bytesToRead` to `fileResponse`, set
  response status to 206, add `Content-Range` header
- For unsatisfiable ranges: return 416 with `Content-Range: bytes */total`
- Add `Accept-Ranges: bytes` to all 200 responses (may already be done in Task 1)
- Range handling is skipped if the conditional check would return 304
- Ensure `pnpm check:tsgo` and `pnpm lint-fix` pass

### Task 4: Write tests

Create `packages/effect/test/unstable/http/HttpStaticFiles.test.ts`:

- Use `describe`/`test` from `@effect/vitest` and `deepStrictEqual`/`strictEqual`
  from `@effect/vitest/utils`
- Use `HttpEffect.toWebHandlerLayer` or `HttpRouter.toWebHandler` to create test
  handlers
- Set up real test files in a temp directory using `beforeAll`/`afterAll` with
  Node.js `fs` (or use an in-memory FileSystem layer if available)
- Test cases:
  - Basic file serving: correct content type, response body matches file
  - Index file fallback: directory path serves `index.html`
  - Custom index file name
  - Index disabled (`index: undefined`)
  - 304 Not Modified via `If-None-Match` (exact match, weak match, `*`)
  - 304 Not Modified via `If-Modified-Since`
  - No 304 when file has been modified
  - Range request: `bytes=0-10` returns 206 with correct content
  - Range request: `bytes=5-` (open-ended)
  - Range request: `bytes=-10` (suffix)
  - Range request: invalid range returns 416
  - Range request: malformed header serves full file (200)
  - SPA fallback: missing path with `Accept: text/html` serves index
  - SPA fallback: missing path with file extension returns 404
  - SPA fallback: missing path without `text/html` accept returns 404
  - Directory traversal: `../../../etc/passwd` returns 404
  - Directory traversal: encoded `..%2F..%2Fetc%2Fpasswd` returns 404
  - Null byte in path returns 404
  - Malformed URI encoding returns 404
  - Custom MIME type overrides
  - `Cache-Control` header is set when configured
  - Unknown file extension returns `application/octet-stream`
  - Non-existent file returns 404
- Ensure tests pass with `pnpm test HttpStaticFiles`
- Run `pnpm check:tsgo` and `pnpm lint-fix`

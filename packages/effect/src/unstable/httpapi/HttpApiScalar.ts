/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Layer from "../../Layer.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import type * as HttpApi from "./HttpApi.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as Html from "./internal/html.ts"
import * as internal from "./internal/httpApiScalar.ts"
import * as OpenApi from "./OpenApi.ts"

/**
 * @since 4.0.0
 * @category model
 */
export type ScalarThemeId =
  | "alternate"
  | "default"
  | "moon"
  | "purple"
  | "solarized"
  | "bluePlanet"
  | "saturn"
  | "kepler"
  | "mars"
  | "deepSpace"
  | "laserwave"
  | "none"

/**
 * @see https://github.com/scalar/scalar/blob/main/documentation/configuration.md
 *
 * @since 4.0.0
 * @category model
 */
export type ScalarConfig = {
  /** A string to use one of the color presets */
  theme?: ScalarThemeId
  /** The layout to use for the references */
  layout?: "modern" | "classic"
  /** URL to a request proxy for the API client */
  proxyUrl?: string
  /** Whether to show the sidebar */
  showSidebar?: boolean
  /**
   * Whether to show models in the sidebar, search, and content.
   *
   * Default: `false`
   */
  hideModels?: boolean
  /**
   * Whether to show the "Test Request" button.
   *
   * Default: `false`
   */
  hideTestRequestButton?: boolean
  /**
   * Whether to show the sidebar search bar.
   *
   * Default: `false`
   */
  hideSearch?: boolean
  /** Whether dark mode is on or off initially (light mode) */
  darkMode?: boolean
  /** forceDarkModeState makes it always this state no matter what */
  forceDarkModeState?: "dark" | "light"
  /** Whether to show the dark mode toggle */
  hideDarkModeToggle?: boolean
  /**
   * Path to a favicon image.
   *
   * Default: `undefined`
   * Example: "/favicon.svg"
   */
  favicon?: string
  /** Custom CSS to be added to the page */
  customCss?: string
  /**
   * The baseServerURL is used when the spec servers are relative paths and we are using SSR.
   * On the client we can grab the window.location.origin but on the server we need
   * to use this prop.
   *
   * Default: `undefined`
   * Example: "http://localhost:3000"
   */
  baseServerURL?: string
  /**
   * We use Inter and JetBrains Mono as the default fonts. If you want to use your own fonts, set this to false.
   *
   * Default: `true`
   */
  withDefaultFonts?: boolean
  /**
   * By default we only open the relevant tag based on the url, however if you want all the tags open by default then set this configuration option.
   *
   * Default: `false`
   */
  defaultOpenAllTags?: boolean
  /**
   * Whether to display the operation ID in the operation reference.
   *
   * Default: `false`
   */
  showOperationId?: boolean
}

type ScalarSource =
  | {
    readonly _tag: "Cdn"
    readonly version?: string | undefined
  }
  | {
    readonly _tag: "Inline"
    readonly source: string
  }

const makeHandler = <Id extends string, Groups extends HttpApiGroup.Any>(options: {
  readonly api: HttpApi.HttpApi<Id, Groups>
  readonly source: ScalarSource
  readonly scalar: ScalarConfig | undefined
}) => {
  const spec = OpenApi.fromApi(options.api)
  const scalarConfig = {
    _integration: "html",
    ...options.scalar
  }
  const response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${Html.escape(spec.info.title)}</title>
    ${
    !spec.info.description
      ? ""
      : `<meta name="description" content="${Html.escape(spec.info.description)}"/>`
  }
    ${
    !spec.info.description
      ? ""
      : `<meta name="og:description" content="${Html.escape(spec.info.description)}"/>`
  }
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">
      ${Html.escapeJson(spec)}
    </script>
    <script>
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(${Html.escapeJson(scalarConfig)})
    </script>
    ${
    options.source._tag === "Cdn"
      ? `<script src="${`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${
        options.source.version ?? "latest"
      }/dist/browser/standalone.min.js`}" crossorigin></script>`
      : `<script>${options.source.source}</script>`
  }
  </body>
</html>`)
  return Effect.succeed(response)
}

/**
 * @since 4.0.0
 * @category layers
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Inline",
        source: internal.javascript
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))

/**
 * @since 4.0.0
 * @category layers
 */
export const layerCdn = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
    readonly version?: string | undefined
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Cdn",
        version: options?.version
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))

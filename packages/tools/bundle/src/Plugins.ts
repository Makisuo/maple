/**
 * @since 1.0.0
 */
import { nodeResolve } from "@rollup/plugin-node-resolve"
import replace from "@rollup/plugin-replace"
import terser from "@rollup/plugin-terser"
import type * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import type { Plugin } from "rollup"
import esbuild from "rollup-plugin-esbuild"
import { visualizer } from "rollup-plugin-visualizer"

const EFFECT_PACKAGE_REGEX = /^(@effect\/[\w-]+|effect)(\/.*)?$/

/**
 * Options for configuring Rollup plugins.
 *
 * @since 1.0.0
 * @category models
 */
export interface PluginOptions {
  readonly nodeTarget?: string | undefined
  readonly minify?: boolean | undefined
  readonly mangle?: boolean | undefined
  readonly visualize?: boolean | undefined
}

interface ResolvedPluginOptions {
  readonly nodeTarget: string
  readonly minify: boolean
  readonly mangle: boolean
  readonly visualize: boolean
}

const defaultPluginOptions: ResolvedPluginOptions = {
  nodeTarget: "node20",
  minify: true,
  mangle: true,
  visualize: false
}

/**
 * Merges provided options with defaults.
 */
const resolvePluginOptions = (options: PluginOptions): ResolvedPluginOptions => ({
  nodeTarget: options.nodeTarget ?? defaultPluginOptions.nodeTarget,
  minify: options.minify ?? defaultPluginOptions.minify,
  mangle: options.mangle ?? defaultPluginOptions.mangle,
  visualize: options.visualize ?? defaultPluginOptions.visualize
})

/**
 * Creates a custom Rollup plugin that resolves Effect package imports to their
 * local dist directories.
 *
 * @since 1.0.0
 * @category constructors
 */
export const createResolveLocalPackageImports = (pathService: Path.Path): Plugin => ({
  name: "rollup-plugin-resolve-imports",
  async resolveId(source, importer) {
    const match = source.match(EFFECT_PACKAGE_REGEX)
    if (Predicate.isNotNull(match)) {
      const packageName = match[1]
      const subpath = match[2]
      const resolved = await this.resolve(`${packageName}/package.json`, importer, { skipSelf: true })
      if (resolved === null) return null
      const packageDir = pathService.dirname(resolved.id)
      const modulePath = subpath ? subpath.slice(1) : "index"
      const distPath = pathService.join(packageDir, "dist", `${modulePath}.js`)
      return { id: distPath, external: false }
    }
    return null
  }
})

/**
 * Creates the full Rollup plugin pipeline for bundling.
 *
 * @since 1.0.0
 * @category constructors
 */
export const createPlugins = (pathService: Path.Path, options: PluginOptions = {}): Array<Plugin> => {
  const resolved = resolvePluginOptions(options)
  const plugins: Array<Plugin> = [
    createResolveLocalPackageImports(pathService),
    nodeResolve(),
    // @ts-expect-error see https://github.com/rollup/plugins/issues/1662
    replace({
      "process.env.NODE_ENV": JSON.stringify("production"),
      preventAssignment: true
    }),
    esbuild({
      target: resolved.nodeTarget,
      format: "esm",
      treeShaking: true
    }),
    // @ts-expect-error see https://github.com/rollup/plugins/issues/1662
    terser({
      format: { comments: false },
      compress: resolved.minify,
      mangle: resolved.mangle && !resolved.visualize
    })
  ]

  if (resolved.visualize) {
    plugins.push(visualizer({
      open: true,
      gzipSize: true
    }))
  }

  return plugins
}

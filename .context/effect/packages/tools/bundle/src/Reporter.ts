/**
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ServiceMap from "effect/ServiceMap"
import { Fixtures } from "./Fixtures.ts"
import type { BundleStats } from "./Rollup.ts"
import { Rollup } from "./Rollup.ts"

/**
 * @since 1.0.0
 * @category errors
 */
export class ReporterError extends Data.TaggedError("ReporterError")<{
  readonly cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export interface ReportOptions {
  readonly baseDirectory: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface VisualizeOptions {
  readonly paths: ReadonlyArray<string>
  readonly outputDirectory: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface ReportSelectedOptions {
  readonly paths: ReadonlyArray<string>
}

/**
 * @since 1.0.0
 * @category services
 */
export class Reporter extends ServiceMap.Service<Reporter>()(
  "@effect/bundle/Reporter",
  {
    make: Effect.gen(function*() {
      const path = yield* Path.Path
      const { fixtures, fixturesDir } = yield* Fixtures
      const rollup = yield* Rollup

      const calculateDifference = (current: BundleStats, previous: BundleStats) => {
        const currSize = current.sizeInBytes
        const prevSize = previous.sizeInBytes
        const diff = currSize - prevSize
        const diffPct = prevSize === 0 ? 0 : (Math.abs(diff) / prevSize) * 100
        const currKb = (currSize / 1000).toFixed(2)
        const prevKb = (prevSize / 1000).toFixed(2)
        const diffKb = (Math.abs(diff) / 1000).toFixed(2)
        const filename = path.basename(current.path)
        return {
          diff,
          diffPct,
          currKb,
          prevKb,
          diffKb,
          filename
        }
      }

      const createReport = (curr: ReadonlyArray<BundleStats>, prev: ReadonlyArray<BundleStats>): string => {
        const lines: Array<string> = [
          "| File Name | Current Size | Previous Size | Difference |",
          "|:----------|:------------:|:-------------:|:----------:|"
        ]
        for (const current of curr) {
          const previous = prev.find((previous) => {
            return path.basename(previous.path) === path.basename(current.path)
          }) ?? current
          const comparison = calculateDifference(current, previous)
          const filename = `\`${comparison.filename}\``
          const currKb = `${comparison.currKb} KB`
          const prevKb = `${comparison.prevKb} KB`
          const diffKb = `${comparison.diffKb} KB`
          const diffPct = `${comparison.diffPct.toFixed(2)}%`
          const sign = comparison.diff === 0 ? "" : comparison.diff > 0 ? "+" : "-"
          const line = `| ${filename} | ${currKb} | ${prevKb} | ${sign}${diffKb} (${sign}${diffPct}) |`
          lines.push(line)
        }
        return lines.join("\n") + "\n"
      }

      const createSelectedReport = (stats: ReadonlyArray<BundleStats>): string => {
        const lines: Array<string> = [
          "| File Name | Current Size |",
          "|:----------|:------------:|"
        ]

        for (const current of stats) {
          const filename = `\`${path.basename(current.path)}\``
          const currKb = `${(current.sizeInBytes / 1000).toFixed(2)} KB`
          const line = `| ${filename} | ${currKb} |`
          lines.push(line)
        }

        return lines.join("\n") + "\n"
      }

      const report = Effect.fn("Reporter.report")(
        function*(options: ReportOptions) {
          yield* Effect.logInfo(`Found ${fixtures.length} files to bundle`)

          const [currentStats, previousStats] = yield* Effect.all([
            rollup.bundleAll({
              paths: fixtures.map((fixture) => path.join(fixturesDir, fixture))
            }),
            rollup.bundleAll({
              paths: fixtures.map((fixture) => path.join(options.baseDirectory, fixture))
            })
          ], { concurrency: 2 })

          yield* Effect.logInfo("Bundling complete! Generating bundle size report...")

          return createReport(currentStats, previousStats)
        }
      )

      const visualize = Effect.fn("Reporter.visualize")(
        function*(options: VisualizeOptions) {
          yield* rollup.bundleAll({
            paths: options.paths,
            outputDirectory: options.outputDirectory,
            visualize: true
          })
        }
      )

      const reportSelected = Effect.fn("Reporter.reportSelected")(
        function*(options: ReportSelectedOptions) {
          yield* Effect.logInfo(`Found ${options.paths.length} files to bundle`)
          const stats = yield* rollup.bundleAll({ paths: options.paths })
          yield* Effect.logInfo("Bundling complete! Generating bundle size report...")
          return createSelectedReport(stats)
        }
      )

      return {
        report,
        reportSelected,
        visualize
      } as const
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Fixtures.layer),
    Layer.provide(Rollup.layer)
  )
}

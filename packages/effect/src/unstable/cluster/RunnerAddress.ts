/**
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/cluster/RunnerAddress"

/**
 * @since 4.0.0
 * @category models
 */
export class RunnerAddress extends Schema.Class<RunnerAddress>(TypeId)({
  host: Schema.String,
  port: Schema.Number
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;

  /**
   * @since 4.0.0
   */
  [Equal.symbol](that: RunnerAddress): boolean {
    return this.host === that.host && this.port === that.port
  }

  /**
   * @since 4.0.0
   */
  [Hash.symbol]() {
    return Hash.string(`${this.host}:${this.port}`)
  }

  /**
   * @since 4.0.0
   */
  [PrimaryKey.symbol](): string {
    return `${this.host}:${this.port}`
  }

  /**
   * @since 4.0.0
   */
  override toString(): string {
    return `RunnerAddress(${this.host}:${this.port})`
  }

  /**
   * @since 4.0.0
   */
  [NodeInspectSymbol](): string {
    return this.toString()
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (host: string, port: number): RunnerAddress =>
  new RunnerAddress({ host, port }, { disableChecks: true })

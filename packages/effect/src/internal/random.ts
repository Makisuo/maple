import * as ServiceMap from "../ServiceMap.ts"

/** @internal */
export interface Random {
  nextIntUnsafe(): number
  nextDoubleUnsafe(): number
}

/** @internal */
export const Random: ServiceMap.Reference<Random> = ServiceMap.Reference<Random>("effect/Random", {
  defaultValue: () => ({
    nextIntUnsafe() {
      return Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) +
        Number.MIN_SAFE_INTEGER
    },
    nextDoubleUnsafe() {
      return Math.random()
    }
  })
})

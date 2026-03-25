/**
 * @since 4.0.0
 */

/**
 * @category Model
 * @since 4.0.0
 */
export interface Differ<in out T, in out Patch> {
  readonly empty: Patch
  diff(oldValue: T, newValue: T): Patch
  combine(first: Patch, second: Patch): Patch
  patch(oldValue: T, patch: Patch): T
}

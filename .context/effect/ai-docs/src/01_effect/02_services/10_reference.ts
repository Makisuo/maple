/**
 * @title ServiceMap.Reference
 *
 * For defining configuration values, feature flags, or any other service that has a default value.
 */
import { ServiceMap } from "effect"

export const FeatureFlag = ServiceMap.Reference<boolean>("myapp/FeatureFlag", {
  defaultValue: () => false
})

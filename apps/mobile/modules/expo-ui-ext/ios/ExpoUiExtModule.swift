import ExpoModulesCore
import ExpoUI

public class ExpoUiExtModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoUiExt")

    OnCreate {
      ViewModifierRegistry.register("segmentedTint") { params, appContext, _ in
        return try SegmentedTintModifier(from: params, appContext: appContext)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister("segmentedTint")
    }
  }
}

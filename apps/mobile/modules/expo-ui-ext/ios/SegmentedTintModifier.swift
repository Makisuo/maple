import ExpoModulesCore
import ExpoUI
import SwiftUI
import UIKit

internal struct SegmentedTintModifier: ViewModifier, Record {
  @Field var color: Color?

  func body(content: Content) -> some View {
    if let color {
      let uiColor = UIColor(color)
      return AnyView(
        content.onAppear {
          UISegmentedControl.appearance().selectedSegmentTintColor = uiColor
          UISegmentedControl.appearance().setTitleTextAttributes(
            [.foregroundColor: UIColor.white],
            for: .selected
          )
        }
      )
    } else {
      return AnyView(content)
    }
  }
}

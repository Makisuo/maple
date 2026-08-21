import Foundation
import UIKit

/// A stable identifier for this installation of the app.
///
/// It exists to answer one question for the server: "which credential does a
/// re-mint replace?" Nothing else — it is never a user identity, it never
/// leaves this device except as that path parameter, and it is opaque to Maple.
///
/// Deliberately **not** the APNs device token, which was the obvious choice
/// because push registration already establishes a device row. A user who
/// declines notifications has no APNs token and still pins widgets, so keying
/// on it would have quietly meant "no widget refresh unless you also accept
/// alerts" — two permissions that have nothing to do with each other.
enum AppInstallation {
	private static let key = "installation.id"

	/// `identifierForVendor` where the system has one, and a generated UUID
	/// where it does not.
	///
	/// The fallback matters more than it looks: `identifierForVendor` is nil
	/// before the first unlock after a reboot, which is exactly when a widget
	/// might be rebuilding. Persisting whichever value is resolved first keeps
	/// one installation from minting a second credential — and orphaning its
	/// first — just because it happened to ask at a bad moment.
	///
	/// It also resets when the last app from this vendor is deleted, which is
	/// the right behaviour: a reinstall is a new installation, and the
	/// credential the old one held expires on its own.
	static var identifier: String {
		let defaults = UserDefaults.standard
		if let stored = defaults.string(forKey: key), !stored.isEmpty { return stored }
		let identifier = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
		defaults.set(identifier, forKey: key)
		return identifier
	}
}

import { ActivationEmail } from "../onboarding"

/** react-email preview entry — renders ActivationEmail with sample props. */
export default function Activation() {
	return ActivationEmail({ dashboardUrl: "https://app.maple.dev", serviceName: "checkout-api" })
}

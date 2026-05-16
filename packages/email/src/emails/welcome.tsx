import { WelcomeEmail } from "../onboarding"

/** react-email preview entry — renders WelcomeEmail with sample props. */
export default function Welcome() {
	return WelcomeEmail({ dashboardUrl: "https://app.maple.dev", trialDays: 14 })
}

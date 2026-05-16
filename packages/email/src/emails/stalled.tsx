import { StalledEmail } from "../onboarding"

/** react-email preview entry — renders StalledEmail with sample props. */
export default function Stalled() {
	return StalledEmail({ dashboardUrl: "https://app.maple.dev" })
}

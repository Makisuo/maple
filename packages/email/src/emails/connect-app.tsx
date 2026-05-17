import { ConnectAppEmail } from "../onboarding"

/** react-email preview entry — renders ConnectAppEmail with sample props. */
export default function ConnectApp() {
	return ConnectAppEmail({ dashboardUrl: "https://app.maple.dev" })
}

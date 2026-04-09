import { Screen } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import { EmptyView } from "../../components/ui/state-view"

export default function SearchScreen() {
	return (
		<Screen>
			<ScreenHeader title="Search" />
			<EmptyView title="Search" description="Coming soon" />
		</Screen>
	)
}

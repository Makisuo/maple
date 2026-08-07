import { Card, CardContent, CardHeader } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/** Placeholder every account section renders while Clerk's `user` resource loads. */
export function AccountSectionSkeleton() {
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-4 w-64" />
				</CardHeader>
				<CardContent>
					<Skeleton className="h-9 w-full" />
				</CardContent>
			</Card>
		</div>
	)
}

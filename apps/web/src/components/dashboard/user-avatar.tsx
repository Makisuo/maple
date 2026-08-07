/**
 * The signed-in user's avatar. Shared by the sidebar menus, the onboarding header and
 * `/account` so one image/initials fallback covers every surface.
 */
export function UserAvatar({
	imageUrl,
	initials,
	name,
	className,
}: {
	imageUrl?: string
	initials: string
	name: string
	className?: string
}) {
	const base = className ?? "size-6 rounded-md text-[10px]"
	return imageUrl ? (
		<img alt={name} className={`${base} shrink-0 object-cover`} src={imageUrl} />
	) : (
		<div
			className={`${base} flex shrink-0 items-center justify-center bg-muted font-medium text-muted-foreground`}
		>
			{initials}
		</div>
	)
}

/** Two-letter initials from a display name, e.g. "Ada Lovelace" -> "AL". */
export function userInitials(name: string) {
	return name
		.split(" ")
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase()
}

import { Link } from "@tanstack/react-router"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { CopyableField } from "./copyable-field"

/**
 * Endpoint + public/private ingest keys as copyable fields, with the
 * permission-failure fallback for members who can't read org keys. Shared by
 * the Connect popover and any compact credentials surface.
 */
export function ConnectCredentials() {
	const keysResult = useAtomValue(MapleApiV2AtomClient.query("ingestKeys", "retrieve", {}))

	return (
		<div className="space-y-3">
			<CopyableField label="Ingest endpoint" value={ingestUrl} />

			{Result.isFailure(keysResult) ? (
				<p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					Ask an org admin for your ingest keys, or open{" "}
					<Link
						to="/settings"
						search={{ tab: "ingestion" }}
						className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
					>
						Settings → Ingestion
					</Link>
					.
				</p>
			) : (
				<>
					<CopyableField
						label="Public key"
						value={Result.builder(keysResult)
							.onSuccess((v) => v.public_key)
							.orElse(() => "Loading…")}
						masked
					/>
					<CopyableField
						label="Private key"
						value={Result.builder(keysResult)
							.onSuccess((v) => v.private_key)
							.orElse(() => "Loading…")}
						masked
					/>
				</>
			)}
		</div>
	)
}
